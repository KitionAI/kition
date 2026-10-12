//! Workspace state survives a database loss: export, wipe, import.

use kition_store::Db;
use kition_store::rows::{self, AgentSession};
use kition_workspace::AssetStore;
use kition_workspacestorage::StateMirror;
use kition_workspacestorage::storage::classify_path;
use serde_json::{Value, json};

fn mirror(workspace: &std::path::Path, db: Db) -> StateMirror {
    let assets = AssetStore::new(workspace, None).unwrap_or_else(|err| panic!("{err}"));
    StateMirror { db, assets }
}

fn append(conn: &rusqlite::Connection, key: &str, seq: i64, body: &Value) {
    conn.execute(
        "INSERT INTO agent_session_events (session_key, seq, event_type, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![key, seq, body["type"].as_str().unwrap_or_default(), body.to_string(), 100 + seq],
    )
    .unwrap_or_else(|err| panic!("{err}"));
}

fn logged(conn: &rusqlite::Connection, key: &str) -> Vec<(i64, i64, Value)> {
    let mut statement = conn
        .prepare("SELECT seq, created_at, body FROM agent_session_events WHERE session_key = ?1 ORDER BY seq")
        .unwrap_or_else(|err| panic!("{err}"));
    statement
        .query_map([key], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
            ))
        })
        .unwrap_or_else(|err| panic!("{err}"))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|err| panic!("{err}"))
}

#[test]
fn restores_agent_sessions_with_their_log_and_email_state_without_secrets() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = workspace.path().to_string_lossy().into_owned();
    let source = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let user = json!({ "type": "user/message", "content": [{ "type": "text", "text": "hi" }], "source": { "kind": "user" } });
    let reply = json!({ "type": "assistant/message", "content": "Hello", "stopReason": "stop", "model": "m",
        "rawItems": [{ "type": "provider_note", "note": "fake-raw-secret" }] });
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
        append(
            &conn,
            &format!("agent:{id}"),
            1,
            &json!({ "type": "turn/start", "turn": 1 }),
        );
        append(&conn, &format!("agent:{id}"), 2, &user);
        append(&conn, &format!("agent:{id}"), 3, &reply);
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

    let dir = workspace.path().join(".kition/agents/1");
    let snapshot: Value =
        serde_json::from_slice(&std::fs::read(dir.join("session.json")).unwrap_or_default())
            .unwrap_or_default();
    assert_eq!(snapshot["schema_version"], json!(3));
    assert_eq!(snapshot["session"]["workspace_root"], json!("."));
    let lines: Vec<Value> = std::fs::read_to_string(dir.join("session-events.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_default())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(
        lines[0],
        json!({ "seq": 1, "at": 101, "type": "turn/start", "turn": 1 })
    );
    assert_eq!(lines[2]["content"], "Hello");
    assert!(lines[2].get("rawItems").is_none(), "{}", lines[2]);
    assert!(!dir.join("messages.jsonl").exists());
    assert!(!workspace.path().join(".kition/agents/2").exists());
    let email = std::fs::read_to_string(workspace.path().join(".kition/sync/email/state.json"))
        .unwrap_or_default();
    assert!(email.contains("Inbox") && !email.contains("secret"));

    let restored = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let target = mirror(workspace.path(), restored.clone());
    for _ in 0..2 {
        target
            .import_agent_state()
            .unwrap_or_else(|err| panic!("{err}"));
    }
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
    let mut stripped = reply.clone();
    stripped
        .as_object_mut()
        .map(|reply| reply.remove("rawItems"));
    assert_eq!(
        logged(&conn, "agent:1"),
        [
            (1, 101, json!({ "type": "turn/start", "turn": 1 })),
            (2, 102, user),
            (3, 103, stripped),
        ],
        "imported once, without provider-native items"
    );
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
fn older_snapshots_are_not_imported() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let dir = workspace.path().join(".kition/agents/5");
    std::fs::create_dir_all(&dir).unwrap_or_else(|err| panic!("{err}"));
    let old = json!({"schema_version": 2, "session": {"id": 5, "user_id": 1, "title": "Old", "workspace_root": ".",
        "created_at": 1, "updated_at": 1}});
    std::fs::write(dir.join("session.json"), old.to_string()).unwrap_or_else(|err| panic!("{err}"));
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
    assert!(
        rows::find::<AgentSession>(&conn, 5)
            .ok()
            .flatten()
            .is_none()
    );
}

#[test]
fn classifies_the_session_log() {
    assert_eq!(
        classify_path(".kition/agents/7/session-events.jsonl"),
        "agent_session_events"
    );
    assert_eq!(
        classify_path(".kition/agents/7/session.json"),
        "agent_session"
    );
    assert_eq!(classify_path(".kition/agents/7/messages.jsonl"), "");
}
