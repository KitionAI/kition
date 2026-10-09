//! Workspace state survives a database loss: export, wipe, import.

use kition_store::Db;
use kition_store::rows::{self, AgentMessage, AgentSession};
use kition_workspace::AssetStore;
use kition_workspacestorage::StateMirror;
use serde_json::{Value, json};

fn mirror(workspace: &std::path::Path, db: Db) -> StateMirror {
    let assets = AssetStore::new(workspace, None).unwrap_or_else(|err| panic!("{err}"));
    StateMirror { db, assets }
}

#[test]
fn restores_agent_and_email_state_without_secrets() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = workspace.path().to_string_lossy().into_owned();
    let source = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    {
        let conn = source.conn().unwrap_or_else(|err| panic!("{err}"));
        let session = AgentSession {
            user_id: 1,
            title: "Plan".into(),
            workspace_root: root.clone(),
            created_at: 7,
            ..Default::default()
        };
        let id = rows::insert(&conn, &session).unwrap_or_else(|err| panic!("{err}"));
        let message = AgentMessage {
            session_id: id,
            user_id: 1,
            role: "user".into(),
            content: "hi".into(),
            created_at: 8,
            ..Default::default()
        };
        rows::insert(&conn, &message).unwrap_or_else(|err| panic!("{err}"));
        let elsewhere = AgentSession {
            user_id: 1,
            title: "Other".into(),
            workspace_root: "/elsewhere".into(),
            ..Default::default()
        };
        rows::insert(&conn, &elsewhere).unwrap_or_else(|err| panic!("{err}"));
        conn.execute(
            "INSERT INTO workflows (id, user_id, name, connection_json, secret_json, target_json, schedule_enabled, interval_minutes, \
             include_attachments, status, synced_messages, cursor_uid_validity, cursor_uid, created_at, updated_at) \
             VALUES ('w1', 1, 'Inbox', '{\"host\":\"h\"}', '{\"password\":\"secret\"}', '{}', 0, 5, 0, 'paused', 0, 0, 0, 1, 2)",
            [],
        )
        .unwrap_or_else(|err| panic!("{err}"));
    }
    mirror(workspace.path(), source)
        .export()
        .unwrap_or_else(|err| panic!("{err}"));

    let session_file = workspace.path().join(".kition/agents/1/session.json");
    let snapshot: Value = serde_json::from_slice(&std::fs::read(&session_file).unwrap_or_default())
        .unwrap_or_default();
    assert_eq!(snapshot["schema_version"], json!(2));
    assert_eq!(snapshot["session"]["workspace_root"], json!("."));
    assert!(!workspace.path().join(".kition/agents/2").exists());
    let email = std::fs::read_to_string(workspace.path().join(".kition/sync/email/state.json"))
        .unwrap_or_default();
    assert!(email.contains("Inbox") && !email.contains("secret"));

    let restored = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let target = mirror(workspace.path(), restored.clone());
    target
        .import_agent_state()
        .unwrap_or_else(|err| panic!("{err}"));
    target
        .import_sync_state()
        .unwrap_or_else(|err| panic!("{err}"));
    let conn = restored.conn().unwrap_or_else(|err| panic!("{err}"));
    let session = rows::find::<AgentSession>(&conn, 1)
        .ok()
        .flatten()
        .unwrap_or_default();
    assert_eq!(
        (
            session.title.as_str(),
            session.workspace_root.as_str(),
            session.created_at
        ),
        ("Plan", root.as_str(), 7)
    );
    let messages: Vec<AgentMessage> =
        rows::select(&conn, "session_id = 1", &[], "id ASC").unwrap_or_default();
    assert_eq!(messages.len(), 1);
    let secret: Option<String> = conn
        .query_row(
            "SELECT secret_json FROM workflows WHERE id = 'w1'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    assert_eq!(secret, None);
}

#[test]
fn imports_version_one_snapshots_with_text_timestamps() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let dir = workspace.path().join(".kition/agents/5");
    std::fs::create_dir_all(&dir).unwrap_or_else(|err| panic!("{err}"));
    let legacy = json!({"schema_version": 1, "session": {"id": 5, "user_id": 1, "title": "Old", "workspace_root": ".",
        "created_at": "2026-10-09T03:57:06Z", "updated_at": "2026-10-09T03:57:06Z"}});
    std::fs::write(dir.join("session.json"), legacy.to_string())
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join(".kition/agents/broken.json"), "x")
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(workspace.path().join(".kition/agents/bad"))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(
        workspace.path().join(".kition/agents/bad/session.json"),
        "{",
    )
    .unwrap_or_else(|err| panic!("{err}"));

    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    mirror(workspace.path(), db.clone())
        .import_agent_state()
        .unwrap_or_else(|err| panic!("{err}"));
    let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
    let session = rows::find::<AgentSession>(&conn, 5)
        .ok()
        .flatten()
        .unwrap_or_default();
    assert_eq!(session.title, "Old");
    assert_eq!(session.created_at, 1_791_518_226_000);
}
