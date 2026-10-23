//! End-to-end email sync against an in-memory mailbox.

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use kition_connections::SecretStore;
use kition_emailsync::imap::{Cursor, FetchBatch, FetchedMessage, MailboxFetcher, SyncError};
use kition_emailsync::service::{Service, ServiceError};
use kition_emailsync::store::Store;
use kition_emailsync::types::{ConnectionConfig, SaveWorkflowInput, ScheduleConfig, TargetConfig};
use kition_emailsync::workspace::WorkspaceWriter;
use kition_kits::{KITS, KitManager};
use kition_store::Db;
use kition_tableclient::TableClient;

#[derive(Default)]
struct FakeMailbox {
    messages: Mutex<Vec<FetchedMessage>>,
    fail_test: Mutex<bool>,
}

impl MailboxFetcher for FakeMailbox {
    fn test<'a>(
        &'a self,
        _config: &'a ConnectionConfig,
        _password: &'a str,
    ) -> BoxFuture<'a, Result<(), SyncError>> {
        Box::pin(async move {
            if *self
                .fail_test
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                Err(SyncError::new(
                    "authentication_failed",
                    "authenticate IMAP account: bad",
                ))
            } else {
                Ok(())
            }
        })
    }

    fn fetch<'a>(
        &'a self,
        _config: &'a ConnectionConfig,
        _password: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<FetchBatch, SyncError>> {
        Box::pin(async move {
            let all = self
                .messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let start = if cursor.uid_validity == 7 {
                cursor.uid + 1
            } else {
                1
            };
            let pending: Vec<_> = all.into_iter().filter(|m| m.uid >= start).collect();
            Ok(FetchBatch {
                uid_validity: 7,
                total: pending.len(),
                messages: pending.into_iter().take(2).collect(),
            })
        })
    }
}

fn message(uid: u32, subject: &str, attachment: bool) -> FetchedMessage {
    let mut raw = format!(
        "From: Ada <ada@example.com>\r\nTo: me@example.com\r\nSubject: {subject}\r\nMessage-ID: <m{uid}@x>\r\n\
         Date: Fri, 09 Oct 2026 03:57:06 +0000\r\nMIME-Version: 1.0\r\n"
    );
    if attachment {
        raw.push_str(
            "Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nHello with file\r\n\
             --B\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n--B--\r\n",
        );
    } else {
        raw.push_str("Content-Type: text/plain\r\n\r\nHello\r\n");
    }
    FetchedMessage {
        uid,
        internal_date: None,
        raw: raw.into_bytes(),
    }
}

struct Setup {
    service: Service,
    mailbox: Arc<FakeMailbox>,
    dir: tempfile::TempDir,
    user_id: i64,
    tables: TableClient,
}

/// The headless Table kit: `KITION_KIT_TABLE_BINARY`, or a debug build in the sibling
/// checkout. Tests that write messages are skipped without it.
fn table_kit() -> Option<std::path::PathBuf> {
    if let Some(path) =
        std::env::var_os("KITION_KIT_TABLE_BINARY").filter(|value| !value.is_empty())
    {
        return Some(path.into());
    }
    let sibling = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../kition-table/target/debug/kit-table")
        .with_extension(std::env::consts::EXE_EXTENSION);
    sibling.is_file().then_some(sibling)
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let db = Db::open(&dir.path().join("data/kition.db").to_string_lossy())
        .unwrap_or_else(|err| panic!("{err}"));
    let user_id = {
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        kition_store::seed::run(&conn).unwrap_or_else(|err| panic!("{err}"));
        kition_store::users::find_local_user(&conn)
            .ok()
            .flatten()
            .map(|u| u.id)
            .unwrap_or(1)
    };
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap_or_else(|err| panic!("{err}"));
    let kit = KITS
        .iter()
        .find(|kit| kit.id == "kit.table")
        .unwrap_or_else(|| panic!("no table kit"));
    let kits = KitManager::new(Some(workspace.clone()), vec![(kit, table_kit())]);
    let tables = TableClient::new(kits, kition_core::events::EventBus::default());
    let mailbox = Arc::new(FakeMailbox::default());
    let store = Store {
        db: db.clone(),
        secrets: SecretStore::with_key_path(dir.path().join("key")),
    };
    let service = Service::new(
        store,
        mailbox.clone(),
        WorkspaceWriter {
            root: workspace,
            tables: tables.clone(),
        },
    );
    Setup {
        service,
        mailbox,
        dir,
        user_id,
        tables,
    }
}

fn input(include_attachments: bool) -> SaveWorkflowInput {
    SaveWorkflowInput {
        name: Some(" Inbox ".into()),
        connection: Some(ConnectionConfig {
            host: "imap.example.com".into(),
            port: 993,
            username: "u".into(),
            ..Default::default()
        }),
        password: Some("p".into()),
        target: Some(TargetConfig {
            table_path: "Mail/messages.ktable".into(),
            content_folder: "Mail".into(),
            attachment_folder: "Mail/Attachments".into(),
            table_id: 0,
        }),
        schedule: Some(ScheduleConfig {
            enabled: false,
            interval_minutes: 0,
        }),
        include_attachments: Some(include_attachments),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_messages_and_skips_on_resync() {
    if table_kit().is_none() {
        eprintln!(
            "skipped: build kit-table (cargo build -p kit-table in ../kition-table) or set KITION_KIT_TABLE_BINARY"
        );
        return;
    }
    let Setup {
        service,
        mailbox,
        dir,
        user_id,
        tables,
    } = setup();
    mailbox
        .messages
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .extend([
            message(1, "Hello / World", false),
            message(2, "Report", true),
            message(3, "Hello / World", false),
        ]);
    let workflow = service
        .create(user_id, input(true))
        .await
        .unwrap_or_else(|err| panic!("{err:?}"));
    assert_eq!(workflow.name, "Inbox");
    assert_eq!(workflow.connection.tls_mode, "tls");
    assert_eq!(workflow.connection.mailbox, "INBOX");
    assert_eq!(workflow.status, "paused");
    assert_eq!(workflow.schedule.interval_minutes, 15);

    let first = service
        .sync(user_id, &workflow.id, false)
        .await
        .unwrap_or_else(|(err, _)| panic!("{err}"))
        .unwrap_or_default();
    assert_eq!((first.imported, first.skipped, first.failed), (2, 0, 0));
    let root = dir.path().join("workspace");
    assert!(root.join("Mail/2026/10/Hello - World.md").is_file());
    let report = std::fs::read_to_string(root.join("Mail/2026/10/Report.md")).unwrap_or_default();
    assert!(report.contains("| **From** | \"Ada\" <ada@example.com> |"));
    assert!(report.contains("## Attachments"));
    let attachment_links = report
        .lines()
        .filter(|l| l.starts_with("- [data.csv](<"))
        .count();
    assert_eq!(attachment_links, 1);

    let rest = service.sync_all_compat(user_id, &workflow.id).await;
    assert_eq!(
        rest.imported, 1,
        "the third message is imported on the next batch"
    );
    let duplicate = std::fs::read_dir(root.join("Mail/2026/10"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(
        duplicate, 3,
        "a second message with the same subject gets a keyed file name"
    );

    let path = "Mail/messages.ktable";
    let listed_tables = tables
        .tables(path)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        listed_tables.len(),
        1,
        "the starter table makes way for the email table"
    );
    assert_eq!(listed_tables[0].name, "email_messages");
    let records = tables
        .records(path, &listed_tables[0].id)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(records.len(), 3);
    let history = tables
        .request(path, "historyState", serde_json::json!({}), None)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_ne!(
        history["canUndo"], true,
        "email sync writes are system:emailsync, not undo steps: {history}"
    );

    let listed = service.list(user_id).await.unwrap_or_default();
    assert_eq!(listed[0].synced_messages, 3);

    let again = service
        .sync(user_id, &workflow.id, true)
        .await
        .unwrap_or_else(|(err, _)| panic!("{err}"))
        .unwrap_or_default();
    assert_eq!(
        (again.imported, again.skipped),
        (0, 3),
        "a full resync skips completed messages"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_complete_and_conflict() {
    if table_kit().is_none() {
        eprintln!("skipped: build kit-table or set KITION_KIT_TABLE_BINARY");
        return;
    }
    let Setup {
        service,
        mailbox,
        user_id,
        dir: _dir,
        ..
    } = setup();
    mailbox
        .messages
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(message(1, "One", false));
    let workflow = service
        .create(user_id, input(false))
        .await
        .unwrap_or_else(|err| panic!("{err:?}"));
    let run = service
        .create_run(user_id, &workflow.id, "full", false)
        .await
        .unwrap_or_else(|err| panic!("{err:?}"))
        .unwrap_or_default();
    assert_eq!(run.status, "queued");
    assert_eq!(
        service
            .create_run(user_id, &workflow.id, "", false)
            .await
            .err(),
        Some(ServiceError::RunActive)
    );
    service.execute_run(&run.id).await;
    let finished = service
        .store
        .get_run(user_id, &run.id)
        .ok()
        .flatten()
        .unwrap_or_default();
    assert_eq!(finished.status, "completed");
    assert_eq!((finished.imported, finished.processed_messages), (1, 1));
    assert!(finished.finished_at.is_some());
    assert!(matches!(
        service.retry_run(user_id, &run.id).await,
        Err(ServiceError::Invalid(message)) if message.contains("can be retried")
    ));
}

#[tokio::test]
async fn create_reports_mailbox_errors() {
    let Setup {
        service,
        mailbox,
        user_id,
        dir: _dir,
        ..
    } = setup();
    *mailbox
        .fail_test
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    let err = service.create(user_id, input(false)).await.err();
    assert!(matches!(err, Some(ServiceError::Sync(e)) if e.code == "authentication_failed"));
}

trait SyncAllCompat {
    async fn sync_all_compat(&self, user_id: i64, id: &str) -> kition_emailsync::types::SyncResult;
}

impl SyncAllCompat for Service {
    async fn sync_all_compat(&self, user_id: i64, id: &str) -> kition_emailsync::types::SyncResult {
        self.sync(user_id, id, false)
            .await
            .unwrap_or_else(|(err, _)| panic!("{err}"))
            .unwrap_or_default()
    }
}
