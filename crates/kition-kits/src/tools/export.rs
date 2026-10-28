//! `<prefix>_export` (KHP A41): writes the document to a new file in one of the formats the kit
//! exports, through its engine's export command ([`KitExport`]). The command answers the file
//! as base64 in the field the kit names and never writes a file itself; Kition writes it, as a
//! new file only: when `to` exists, the next free name (`Logo 2.png`) is used instead (A29).
//!
//! The export goes where the kit's other tools go (A7): the agent's draft, the file's open
//! editor, or the headless kit. Each passes the kit's own fixed parameters, so the open editor and
//! the headless kit export the same thing (A26). An export is never an edit: nothing is saved,
//! and whether the kit reports the command as a change (a view revision) is not looked at.

use base64::Engine as _;
use serde_json::{Map, Value, json};

use super::errors::{ErrorCode, KitToolError};
use super::{
    KitToolOutput, KitToolResult, draft_editor, kit_path, live, reads_headless_draft, short,
    text_field,
};
use crate::drafts;
use crate::manager::{Caller, FileWrite, KitDefinition, KitExport, KitManager};

/// The formats `kit` exports for the agent, for a message: `png, jpg, svg, or pdf`.
pub(super) fn listed(export: &KitExport) -> String {
    match export.formats {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{}, or {last}", rest.join(", ")),
    }
}

/// The format and the new file's path: `format` or the extension of `to`, which must be one the
/// kit exports; `to` without an extension takes the format's.
pub(super) fn target(input: &Value, export: &KitExport) -> Result<(String, String), KitToolError> {
    let to = text_field(input, "to");
    if to.is_empty() {
        return Err(KitToolError::invalid(
            "missing `to`, the new file's workspace path",
        ));
    }
    let name = to.rsplit('/').next().unwrap_or(&to);
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    let asked = text_field(input, "format").to_ascii_lowercase();
    let format = if asked.is_empty() {
        extension.clone().unwrap_or_default()
    } else {
        asked
    };
    if !export.formats.contains(&format.as_str()) {
        return Err(KitToolError::invalid(format!(
            "cannot export {}: the formats are {}",
            if format.is_empty() {
                "a file without a format".to_owned()
            } else {
                format!("`{format}`")
            },
            listed(export)
        )));
    }
    match extension {
        None => Ok((format.clone(), format!("{to}.{format}"))),
        Some(extension) if extension == format => Ok((format, to)),
        Some(extension) => Err(KitToolError::invalid(format!(
            "`{to}` ends in .{extension}, not .{format}: name the new file for its format"
        ))),
    }
}

/// The command's parameters: the agent's `options`, then the kit's fixed ones and `format`. A
/// `path` never reaches the kit: Kition writes the file.
pub(super) fn params(
    export: &KitExport,
    format: &str,
    options: Option<&Value>,
) -> Result<Map<String, Value>, KitToolError> {
    let mut params = match options {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(options)) => options.clone(),
        Some(_) => return Err(KitToolError::invalid("`options` must be an object")),
    };
    let fixed: Map<String, Value> = serde_json::from_str(export.params).map_err(|error| {
        KitToolError::new(
            ErrorCode::Failed,
            format!("the kit's export parameters are not a JSON object: {error}"),
        )
    })?;
    for (key, value) in fixed {
        params.entry(key).or_insert(value);
    }
    params.remove("path");
    params.insert("format".into(), json!(format));
    Ok(params)
}

/// The exported file from the command's answer: base64 in `export.data`.
pub(super) fn decode(export: &KitExport, answer: Option<&Value>) -> Result<Vec<u8>, KitToolError> {
    let data = answer
        .and_then(|answer| answer.get(export.data))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KitToolError::new(
                ErrorCode::Failed,
                format!(
                    "`{}` answered no `{}` with the file",
                    export.command, export.data
                ),
            )
        })?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| {
            KitToolError::new(
                ErrorCode::Failed,
                format!("the kit sent an unreadable file: {error}"),
            )
        })
}

/// `to`, or the first of `name 2.ext`, `name 3.ext`, ... that `taken` says is free.
pub(super) fn free_name(to: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(to) {
        return to.to_owned();
    }
    let (stem, extension) = match to.rsplit_once('.') {
        Some((stem, extension)) if !stem.ends_with('/') && !stem.is_empty() => {
            (stem, format!(".{extension}"))
        }
        _ => (to, String::new()),
    };
    (2..)
        .map(|n| format!("{stem} {n}{extension}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| to.to_owned())
}

/// The result of the steps an editor ran (`ai/run`): the first step's.
pub(super) fn first_result(answer: &Value) -> Option<&Value> {
    answer["completed"]
        .get(0)
        .and_then(|step| step.get("result"))
}

pub(super) async fn export(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    draft: bool,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let Some(export) = &kit.agent.export else {
        return Err(KitToolError::new(
            ErrorCode::Unsupported,
            format!("{} cannot export files for the agent", short(kit)),
        ));
    };
    let (format, to) = target(input, export)?;
    let params = params(export, &format, input.get("options"))?;
    let step = json!([{ "command": export.command, "params": params }]);
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    let (bytes, live_editor, from_draft) =
        if reads_headless_draft(kits, kit, &path, draft, explicit).await {
            let id = drafts::document(kits, kit, &path, false).await?;
            let executed = kits
                .execute(Caller::Agent, kit.id, &id, export.command, params)
                .await?;
            (decode(export, executed.result.as_ref())?, false, true)
        } else if draft && (live(kits, kit, &path).await.is_some() || explicit) {
            let document = draft_editor(kits, kit, &path).await?;
            let answer = kits
                .bridge()
                .call(
                    &document,
                    "run",
                    json!({ "steps": step, "save": false, "draft": true }),
                )
                .await
                .map_err(|error| {
                    KitToolError::from(error)
                        .context(&format!("on the draft in the open {} editor: ", short(kit)))
                })?;
            (decode(export, first_result(&answer))?, true, true)
        } else if let Some(document) = live(kits, kit, &path).await {
            let answer = kits
                .bridge()
                .call(&document, "run", json!({ "steps": step, "save": false }))
                .await
                .map_err(|error| {
                    KitToolError::from(error)
                        .context(&format!("in the open {} editor: ", short(kit)))
                })?;
            (decode(export, first_result(&answer))?, true, false)
        } else {
            let view = kits.open(Caller::Agent, &path).await?;
            let executed = kits
                .execute(
                    Caller::Agent,
                    view.kit_id,
                    &view.document_id,
                    export.command,
                    params,
                )
                .await?;
            (decode(export, executed.result.as_ref())?, false, false)
        };
    let written = free_name(&to, |candidate| {
        kits.resolve(candidate).is_ok_and(|real| real.exists())
    });
    kits.write_file(&written, &bytes, FileWrite::New)?;
    let what = if from_draft {
        format!("your draft of `{path}`")
    } else {
        format!("`{path}`")
    };
    Ok(KitToolOutput::new(
        format!(
            "Exported {what} as {} to `{written}` ({} bytes).",
            format.to_ascii_uppercase(),
            bytes.len()
        ),
        json!({
            "files": [{ "path": written, "version": drafts::sha256(&bytes), "created": true }],
            "format": format,
            "bytes": bytes.len(),
            "live": live_editor,
            "draft": from_draft,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIG: KitExport = KitExport {
        command: "file.export",
        formats: &["png", "jpg", "svg", "pdf"],
        data: "data",
        params: r#"{"ids": []}"#,
    };

    #[test]
    fn the_format_comes_from_the_call_or_the_new_files_extension() {
        let to = |input: Value| target(&input, &FIG).map_err(|error| error.message);
        assert_eq!(
            to(json!({ "to": "out/Screen.PNG" })),
            Ok(("png".into(), "out/Screen.PNG".into()))
        );
        assert_eq!(
            to(json!({ "to": "out/Screen", "format": "svg" })),
            Ok(("svg".into(), "out/Screen.svg".into()))
        );
        let wrong = to(json!({ "to": "Screen.gif" })).err().unwrap_or_default();
        assert!(wrong.contains("png, jpg, svg, or pdf"), "{wrong}");
        let mismatch = to(json!({ "to": "Screen.png", "format": "pdf" }))
            .err()
            .unwrap_or_default();
        assert!(mismatch.contains(".png, not .pdf"), "{mismatch}");
        assert!(to(json!({ "to": "Screen" })).is_err(), "no format at all");
        assert!(to(json!({})).is_err(), "`to` is required");
    }

    #[test]
    fn the_kits_fixed_parameters_win_and_no_path_reaches_the_kit() {
        let params = super::params(&FIG, "png", None).unwrap_or_default();
        assert_eq!(Value::Object(params), json!({ "ids": [], "format": "png" }));
        let options = json!({ "scale": 2, "ids": ["1:2"], "path": "/tmp/x.png", "format": "pdf" });
        let params = super::params(&FIG, "png", Some(&options)).unwrap_or_default();
        assert_eq!(
            Value::Object(params),
            json!({ "ids": ["1:2"], "scale": 2, "format": "png" }),
            "the agent may name layers; the format is the call's"
        );
        assert!(super::params(&FIG, "png", Some(&json!([1]))).is_err());
    }

    #[test]
    fn the_file_is_read_from_the_kits_answer_field() {
        let answer = json!({ "format": "png", "data": "iVBORw0KGgo=" });
        assert_eq!(
            decode(&FIG, Some(&answer)).unwrap_or_default(),
            b"\x89PNG\r\n\x1a\n"
        );
        let cube = KitExport {
            data: "base64",
            ..FIG
        };
        let error = decode(&cube, Some(&answer))
            .err()
            .map(|error| error.message);
        assert!(
            error.is_some_and(|message| message.contains("no `base64`")),
            "each kit names its own field"
        );
        assert!(decode(&FIG, None).is_err());
    }

    #[test]
    fn an_existing_file_is_never_replaced() {
        let taken = ["out/Screen.png", "out/Screen 2.png"];
        let free = |to: &str| free_name(to, |candidate| taken.contains(&candidate));
        assert_eq!(free("out/Other.png"), "out/Other.png");
        assert_eq!(free("out/Screen.png"), "out/Screen 3.png");
    }
}
