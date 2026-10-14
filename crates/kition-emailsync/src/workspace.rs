//! Writing synced messages into the workspace: one Markdown document per
//! message, attachments beside it, and a row in a `.kitable` index table.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use kition_core::now_millis;
use kition_core::time::to_rfc3339;
use kition_datadoc::index::{self, NewDocument, STORAGE_KITABLE_FILE};
use kition_datadoc::{TableDocuments, TableHandle};
use kition_kdm::Origin;
use kition_kitable::{
    CreateOptions, FieldSpec, KitableError, KitableFile, Table, TablePatch, TableSpec, ViewPatch,
    ViewSpec,
};
use kition_store::Db;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::message::{ParsedAttachment, ParsedMessage, sanitize_attachment_name};
use crate::store::Store;
use crate::types::{TargetConfig, Workflow};

const EMAIL_TABLE_NAME: &str = "email_messages";

/// This service's origin on every write to a `.kitable` file: a non-undo system write, like
/// every other background sync.
fn origin() -> Origin {
    Origin::system("emailsync")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteResult {
    pub document_path: String,
    pub updated: bool,
}

#[derive(Clone)]
pub struct WorkspaceWriter {
    pub root: PathBuf,
    pub db: Db,
    /// Every `.kitable` file the runtime has open, shared with the HTTP routes, the Agent, and
    /// form sync: writing through it (rather than opening the file on its own) keeps an open
    /// window's handle current instead of racing it at the SQLite level.
    pub tables: TableDocuments,
}

fn unsafe_name_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"[<>:"/\\|?*\x00-\x1f\x7f]+"#).unwrap_or_else(|err| panic!("{err}"))
    })
}

fn legacy_key_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"-([0-9a-f]{12})\.md$").unwrap_or_else(|err| panic!("{err}")))
}

/// Lexically cleans a relative path, keeping leading `..`.
fn clean(path: &str) -> PathBuf {
    let mut parts: Vec<Component<'_>> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(Component::Normal(_)) => {
                    parts.pop();
                }
                _ => parts.push(component),
            },
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Whether a cleaned path is a plain relative path. On Windows a rooted
/// path such as `\\etc` or a drive-relative `C:x` is not absolute, yet
/// joining it replaces the base directory.
fn stays_within(cleaned: &Path) -> bool {
    !cleaned.as_os_str().is_empty()
        && cleaned
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

pub fn normalize_relative_path(value: &str, extension: &str) -> Result<PathBuf, String> {
    let cleaned = clean(value.trim());
    if !stays_within(&cleaned) || value.trim().starts_with('/') {
        return Err("email sync path must stay within the workspace".into());
    }
    if !extension.is_empty() {
        let matches = cleaned.extension().is_some_and(|ext| {
            format!(".{}", ext.to_string_lossy()).eq_ignore_ascii_case(extension)
        });
        if !matches {
            return Err(format!(
                "email sync path must use the {extension} extension"
            ));
        }
    }
    Ok(cleaned)
}

pub fn normalize_relative_folder(value: &str) -> Result<PathBuf, String> {
    let cleaned = clean(value.trim());
    if !stays_within(&cleaned) || value.trim().starts_with('/') {
        return Err("email sync folder must stay within the workspace".into());
    }
    Ok(cleaned)
}

pub fn stable_message_key(workflow_id: &str, uid_validity: u32, uid: u32) -> String {
    hex::encode(&Sha256::digest(format!("{workflow_id}:{uid_validity}:{uid}").as_bytes())[..6])
}

pub fn sanitize_document_title(value: &str) -> String {
    let replaced = unsafe_name_pattern().replace_all(value.trim(), "-");
    let trimmed = replaced.trim_matches([' ', '.', '-']);
    if trimmed.is_empty() {
        return "Untitled email".into();
    }
    let limited: String = trimmed.chars().take(120).collect();
    limited.trim().to_owned()
}

pub fn escape_table_cell(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .trim()
        .replace('\n', "<br>")
        .replace('|', "\\|")
}

fn metadata_table(rows: &[(&str, &str)]) -> String {
    let filtered: Vec<_> = rows.iter().filter(|(_, v)| !v.trim().is_empty()).collect();
    if filtered.is_empty() {
        return String::new();
    }
    let mut out = String::from("| Field | Details |\n| --- | --- |\n");
    for (label, value) in filtered {
        out.push_str(&format!(
            "| **{}** | {} |\n",
            escape_table_cell(label),
            escape_table_cell(value)
        ));
    }
    out
}

pub fn render_markdown(message: &ParsedMessage, attachment_links: &[String]) -> String {
    let received = rfc3339_seconds(message.received_at);
    let mut out = metadata_table(&[
        ("From", &message.from),
        ("To", &message.to),
        ("Cc", &message.cc),
        ("Received", &received),
        ("Message ID", &message.message_id),
    ]);
    out.push_str("\n---\n\n");
    out.push_str(message.markdown.trim());
    out.push('\n');
    if !attachment_links.is_empty() {
        out.push_str("\n## Attachments\n\n");
        for (index, link) in attachment_links.iter().enumerate() {
            let name = Path::new(link)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let label = name
                .strip_prefix(&format!("{:02}-", index + 1))
                .unwrap_or(&name)
                .to_owned();
            out.push_str(&format!("- [{label}](<{link}>)\n"));
        }
    }
    out
}

/// RFC 3339 with seconds precision in UTC, the text form used inside
/// documents and table cells.
fn rfc3339_seconds(millis: i64) -> String {
    let text = to_rfc3339(millis - millis.rem_euclid(1000));
    text.replace(".000Z", "Z")
}

fn email_field_specs() -> Vec<FieldSpec> {
    let field = |name: &str, title: &str, field_type: &str| FieldSpec {
        name: name.into(),
        title: title.into(),
        field_type: field_type.into(),
        ..FieldSpec::default()
    };
    vec![
        FieldSpec {
            primary: true,
            required: true,
            ..field("subject", "Subject", "text")
        },
        field("from", "From", "text"),
        field("to", "To", "text"),
        field("received_at", "Received At", "datetime"),
        field("mailbox", "Mailbox", "text"),
        field("preview", "Preview", "long_text"),
        field("has_attachments", "Has Attachments", "checkbox"),
        FieldSpec {
            options: json!({"choices": ["Imported"]}),
            ..field("status", "Status", "single_select")
        },
        field("message_id", "Message ID", "text"),
        FieldSpec {
            readonly: true,
            ..field("document", "Document", "document_link")
        },
    ]
}

fn email_table_spec() -> TableSpec {
    TableSpec {
        name: EMAIL_TABLE_NAME.into(),
        title: "Data table".into(),
        description: "Email metadata with links to the full Markdown message.".into(),
        fields: email_field_specs(),
        views: vec![ViewSpec {
            title: "Grid view".into(),
            view_type: "grid".into(),
            config: Value::Null,
        }],
        meta: Value::Null,
    }
}

/// Renames legacy titles and adds any missing email fields.
fn ensure_email_fields(file: &mut KitableFile, table: &mut Table) -> Result<(), KitableError> {
    if table.name == EMAIL_TABLE_NAME && table.title.trim().eq_ignore_ascii_case("Email Messages") {
        *table = file.update_table(
            table.id,
            &TablePatch {
                title: Some("Data table".into()),
                ..TablePatch::default()
            },
        )?;
    }
    for view in table.views.clone() {
        if view.view_type == "grid" && view.title.trim().eq_ignore_ascii_case("All messages") {
            file.update_view(
                table.id,
                view.id,
                &ViewPatch {
                    title: Some("Grid view".into()),
                    ..ViewPatch::default()
                },
            )?;
        }
    }
    for spec in email_field_specs() {
        if !table.fields.iter().any(|f| f.name == spec.name) {
            file.create_field(table.id, &spec)?;
        }
    }
    *table = file.get_table(table.id)?;
    Ok(())
}

fn text_value(values: &Map<String, Value>, key: &str) -> String {
    match values.get(key) {
        None | Some(Value::Null) => "<nil>".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

impl WorkspaceWriter {
    fn resolve(&self, relative: &str, extension: &str) -> Result<PathBuf, String> {
        Ok(self
            .root
            .join(normalize_relative_path(relative, extension)?))
    }

    fn path_available(&self, relative: &Path, message_id: &str) -> bool {
        match std::fs::read_to_string(self.root.join(relative)) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
            Ok(_) if message_id.trim().is_empty() => false,
            Ok(data) => {
                let id = message_id.trim();
                data.contains(&format!("**Message ID:** {id}"))
                    || data.contains(&format!("| **Message ID** | {} |", escape_table_cell(id)))
            }
        }
    }

    fn document_path(
        &self,
        folder: &str,
        received_at: i64,
        subject: &str,
        message_id: &str,
        key: &str,
    ) -> PathBuf {
        let folder = normalize_relative_folder(folder).unwrap_or_else(|_| PathBuf::from("Mail"));
        let when = chrono::DateTime::from_timestamp_millis(if received_at == 0 {
            now_millis()
        } else {
            received_at
        })
        .unwrap_or_default();
        let directory = folder
            .join(when.format("%Y").to_string())
            .join(when.format("%m").to_string());
        let title = sanitize_document_title(subject);
        let primary = directory.join(format!("{title}.md"));
        if self.path_available(&primary, message_id) {
            primary
        } else {
            directory.join(format!("{title} ({key}).md"))
        }
    }

    fn write_attachments(
        &self,
        folder: &str,
        key: &str,
        attachments: &[ParsedAttachment],
        document_path: &Path,
    ) -> Result<Vec<String>, String> {
        let folder = normalize_relative_folder(folder)?;
        let mut links = Vec::with_capacity(attachments.len());
        for (index, attachment) in attachments.iter().enumerate() {
            let name = format!(
                "{:02}-{}",
                index + 1,
                sanitize_attachment_name(&attachment.filename)
            );
            let relative = folder.join(key).join(&name);
            let absolute = self.resolve(&slash(&relative), "")?;
            kition_workspace::fsutil::write_atomic(&absolute, &attachment.data)
                .map_err(|e| format!("write email attachment: {e}"))?;
            links.push(relative_link(
                document_path.parent().unwrap_or(Path::new("")),
                &relative,
            ));
        }
        Ok(links)
    }

    /// Opens (creating when needed) the destination table, through the shared manager, and
    /// makes sure the file is indexed as a data document.
    fn open_email_table(
        &self,
        user_id: i64,
        target: &TargetConfig,
    ) -> Result<(TableHandle, Table), String> {
        let relative = normalize_relative_path(&target.table_path, ".kitable")?;
        let absolute = self.root.join(&relative);
        let created = std::fs::metadata(&absolute).is_err();
        if created {
            let stem = relative
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            // A brand-new file: created directly, then handed to the manager below so every
            // write after this one goes through the one shared connection.
            KitableFile::create(
                &absolute,
                &CreateOptions {
                    title: stem,
                    document_id: format!("email-sync-{}", uuid::Uuid::new_v4().simple()),
                    meta_json: r#"{"source":"email_sync"}"#.into(),
                    ..CreateOptions::default()
                },
            )
            .map_err(|e| format!("open email table: {e}"))?
            .close();
        }
        let (mut file, _merge) = self
            .tables
            .open(&absolute, origin())
            .map_err(|e| format!("open email table: {e}"))?;
        if let Err(err) = self.ensure_document_index(user_id, &slash(&relative), &file) {
            drop(file);
            if created {
                let _ = std::fs::remove_file(&absolute);
            }
            return Err(err);
        }
        let tables = file
            .list_tables()
            .map_err(|e| format!("list email tables: {e}"))?;
        let mut table = if target.table_id > 0 {
            tables
                .into_iter()
                .find(|t| t.id == target.table_id)
                .ok_or_else(|| {
                    format!(
                        "email sync destination table {} was not found",
                        target.table_id
                    )
                })?
        } else if let Some(found) = tables
            .iter()
            .find(|t| t.name == EMAIL_TABLE_NAME)
            .or_else(|| tables.first())
        {
            found.clone()
        } else {
            let table = file
                .create_table(&email_table_spec())
                .map_err(|e| format!("create email table: {e}"))?;
            return Ok((file, table));
        };
        ensure_email_fields(&mut file, &mut table).map_err(|e| e.to_string())?;
        Ok((file, table))
    }

    fn ensure_document_index(
        &self,
        user_id: i64,
        path: &str,
        file: &TableHandle,
    ) -> Result<(), String> {
        let conn = self.db.conn().map_err(|e| e.to_string())?;
        let root = self.root.to_string_lossy().into_owned();
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, COALESCE(workspace_root, '') FROM data_documents WHERE user_id = ?1 AND path = ?2 AND deleted_at IS NULL LIMIT 1",
                rusqlite::params![user_id, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((id, workspace_root)) = existing {
            if workspace_root.trim() != root {
                index::set_workspace_root(&conn, id, &root).map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        let info = file
            .info()
            .map_err(|e| format!("read email table metadata: {e}"))?;
        let title = match info.title.trim() {
            "" => Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            title => title.to_owned(),
        };
        let meta = json!({
            "storage": STORAGE_KITABLE_FILE,
            "file_format": kition_kitable::FORMAT,
            "file_document_id": info.document_id,
            "file_format_version": info.format_version,
            "file_schema_version": info.schema_version,
            "indexed_from_kitable": true,
            "source": "email_sync",
        });
        index::insert(
            &conn,
            NewDocument {
                user_id,
                workspace_root: root,
                path: path.to_owned(),
                title,
                description: "Email messages synchronized from an IMAP mailbox.".into(),
                icon: String::new(),
                color: String::new(),
                meta: meta.as_object().cloned().unwrap_or_default(),
            },
        )
        .map(|_| ())
        .map_err(|e| format!("create email table index: {e}"))
    }

    pub fn write_message(
        &self,
        workflow: &Workflow,
        uid_validity: u32,
        uid: u32,
        message: &ParsedMessage,
    ) -> Result<WriteResult, String> {
        let target = workflow.target();
        let key = stable_message_key(&workflow.id, uid_validity, uid);
        let document = self.document_path(
            &target.content_folder,
            message.received_at,
            &message.subject,
            &message.message_id,
            &key,
        );
        let document_text = slash(&document);
        let absolute = self.resolve(&document_text, ".md")?;
        let links = if workflow.include_attachments && !message.attachments.is_empty() {
            self.write_attachments(
                &target.attachment_folder,
                &key,
                &message.attachments,
                &document,
            )?
        } else {
            Vec::new()
        };
        kition_workspace::fsutil::write_atomic(
            &absolute,
            render_markdown(message, &links).as_bytes(),
        )
        .map_err(|e| format!("write email Markdown: {e}"))?;

        let (mut file, table) = self.open_email_table(workflow.user_id, &target)?;
        let mut values = Map::new();
        values.insert("subject".into(), json!(message.subject));
        values.insert("from".into(), json!(message.from));
        values.insert("to".into(), json!(message.to));
        values.insert(
            "received_at".into(),
            json!(rfc3339_seconds(message.received_at)),
        );
        values.insert("mailbox".into(), json!(workflow.connection().mailbox));
        values.insert("preview".into(), json!(message.preview));
        values.insert(
            "has_attachments".into(),
            json!(!message.attachments.is_empty()),
        );
        values.insert("status".into(), json!("Imported"));
        values.insert("message_id".into(), json!(message.message_id));
        values.insert("document".into(), json!(document_text));
        let records = file
            .list_records(table.id)
            .map_err(|e| format!("list email table records: {e}"))?;
        if let Some(record) = records
            .iter()
            .find(|r| text_value(&r.values, "document").trim() == document_text)
        {
            file.update_record(table.id, record.id, &values, None)
                .map_err(|e| format!("update email table record: {e}"))?;
            return Ok(WriteResult {
                document_path: document_text,
                updated: true,
            });
        }
        file.create_record(table.id, &values)
            .map_err(|e| format!("create email table record: {e}"))?;
        Ok(WriteResult {
            document_path: document_text,
            updated: false,
        })
    }

    /// Moves documents written by older releases (key-suffixed names,
    /// heading-and-bold metadata) to the current layout.
    pub fn migrate_legacy_documents(
        &self,
        workflow: &Workflow,
        store: &Store,
    ) -> Result<(), String> {
        let target = workflow.target();
        let (mut file, table) = self.open_email_table(workflow.user_id, &target)?;
        let records = file
            .list_records(table.id)
            .map_err(|e| format!("list email records for document migration: {e}"))?;
        for record in records {
            let current = text_value(&record.values, "document")
                .trim()
                .replace('\\', "/");
            let subject = text_value(&record.values, "subject").trim().to_owned();
            let message_id = text_value(&record.values, "message_id").trim().to_owned();
            if current.is_empty() || current == "<nil>" || subject.is_empty() || subject == "<nil>"
            {
                continue;
            }
            let current_abs = self.resolve(&current, ".md")?;
            let markdown = match std::fs::read_to_string(&current_abs) {
                Ok(text) => text,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => return Err(format!("read legacy email document: {err}")),
            };
            let key = legacy_key_pattern()
                .captures(
                    Path::new(&current)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                        .as_str(),
                )
                .map(|c| c[1].to_owned())
                .unwrap_or_else(|| {
                    hex::encode(
                        &Sha256::digest(format!("{}:{message_id}", workflow.id).as_bytes())[..6],
                    )
                });
            let title = sanitize_document_title(&subject);
            let directory = Path::new(&current)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            let mut next = directory.join(format!("{title}.md"));
            if clean(&slash(&next)) != clean(&current) && !self.path_available(&next, &message_id) {
                next = directory.join(format!("{title} ({key}).md"));
            }
            let next_text = slash(&next);
            let upgraded = upgrade_legacy_markdown(&markdown);
            let next_abs = self.resolve(&next_text, ".md")?;
            if next_text != current || upgraded != markdown {
                kition_workspace::fsutil::write_atomic(&next_abs, upgraded.as_bytes())
                    .map_err(|e| format!("write migrated email document: {e}"))?;
                if next_text != current
                    && let Err(err) = std::fs::remove_file(&current_abs)
                    && err.kind() != std::io::ErrorKind::NotFound
                {
                    return Err(format!("remove legacy email document: {err}"));
                }
            }
            if next_text != current {
                let mut values = record.values.clone();
                values.insert("document".into(), json!(next_text));
                file.update_record(table.id, record.id, &values, None)
                    .map_err(|e| format!("update migrated email record: {e}"))?;
                store
                    .rename_item_documents(&workflow.id, &current, &next_text)
                    .map_err(|e| format!("update migrated email sync item: {e}"))?;
            }
        }
        Ok(())
    }
}

/// A relative link from `from_dir` to `target` (both workspace-relative).
fn relative_link(from_dir: &Path, target: &Path) -> String {
    let from: Vec<_> = from_dir.components().collect();
    let to: Vec<_> = target.components().collect();
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_owned(), from.len() - shared).collect();
    parts.extend(
        to[shared..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

fn strip_legacy_heading(markdown: &str) -> String {
    let markdown = markdown.replace("\r\n", "\n");
    if !markdown.starts_with("# ") {
        return markdown;
    }
    match markdown.find("\n\n") {
        Some(end) => markdown[end + 2..].to_owned(),
        None => markdown,
    }
}

fn parse_legacy_metadata_line(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("**")?;
    let marker = rest.find(":**")?;
    let label = rest[..marker].trim().to_owned();
    let value = rest[marker + 3..].trim_end_matches("  ").trim().to_owned();
    matches!(
        label.as_str(),
        "From" | "To" | "Cc" | "Received" | "Message ID"
    )
    .then_some((label, value))
    .filter(|(_, v)| !v.is_empty())
}

pub fn upgrade_legacy_markdown(markdown: &str) -> String {
    let markdown = strip_legacy_heading(markdown);
    if markdown.starts_with("| Field | Details |\n") {
        return markdown;
    }
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut rows = Vec::new();
    let mut separator = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "---" {
            separator = Some(index);
            break;
        }
        match parse_legacy_metadata_line(trimmed) {
            Some(row) => rows.push(row),
            None => return markdown,
        }
    }
    let Some(separator) = separator.filter(|_| !rows.is_empty()) else {
        return markdown;
    };
    let pairs: Vec<(&str, &str)> = rows.iter().map(|(l, v)| (l.as_str(), v.as_str())).collect();
    let mut out = metadata_table(&pairs);
    out.push_str("\n---\n\n");
    out.push_str(lines[separator + 1..].join("\n").trim());
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_titles() {
        assert!(normalize_relative_path("../x.kitable", ".kitable").is_err());
        assert!(normalize_relative_path("x.md", ".kitable").is_err());
        if cfg!(windows) {
            assert!(normalize_relative_path("\\etc\\x.kitable", ".kitable").is_err());
            assert!(normalize_relative_path("C:x.kitable", ".kitable").is_err());
            assert!(normalize_relative_folder("C:\\inbox").is_err());
        }
        assert_eq!(
            normalize_relative_path("a/./b.KITABLE", ".kitable").ok(),
            Some(PathBuf::from("a/b.KITABLE"))
        );
        assert_eq!(
            sanitize_document_title(" Re: <Plan> / Q3? "),
            "Re- -Plan- - Q3"
        );
        assert_eq!(sanitize_document_title("..."), "Untitled email");
        assert_eq!(stable_message_key("mail_x", 1, 2).len(), 12);
        assert_eq!(
            relative_link(
                Path::new("Mail/2026/10"),
                Path::new("Attachments/k/01-a.pdf")
            ),
            "../../../Attachments/k/01-a.pdf"
        );
    }

    #[test]
    fn renders_markdown() {
        let message = ParsedMessage {
            subject: "S".into(),
            from: "<a@b>".into(),
            to: String::new(),
            cc: String::new(),
            received_at: 1_791_518_226_123,
            message_id: "id|1".into(),
            markdown: "Body\n".into(),
            preview: String::new(),
            attachments: Vec::new(),
        };
        let text = render_markdown(&message, &["../a/01-file.pdf".into()]);
        assert_eq!(
            text,
            "| Field | Details |\n| --- | --- |\n| **From** | <a@b> |\n| **Received** | 2026-10-09T03:57:06Z |\n\
             | **Message ID** | id\\|1 |\n\n---\n\nBody\n\n## Attachments\n\n- [file.pdf](<../a/01-file.pdf>)\n"
        );
    }

    #[test]
    fn upgrades_legacy_documents() {
        let legacy =
            "# Subject\n\n**From:** a@b  \n**Received:** 2026-10-09T03:57:06Z\n\n---\n\nHello\n";
        assert_eq!(
            upgrade_legacy_markdown(legacy),
            "| Field | Details |\n| --- | --- |\n| **From** | a@b |\n| **Received** | 2026-10-09T03:57:06Z |\n\n---\n\nHello\n"
        );
        assert_eq!(upgrade_legacy_markdown("plain"), "plain");
    }
}
