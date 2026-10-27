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
fn restores_agent_sessions_with_their_log() {
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
            0,
            &json!({ "type": "turn/start", "turn": 1 }),
        );
        append(&conn, &format!("agent:{id}"), 1, &user);
        append(&conn, &format!("agent:{id}"), 2, &reply);
        let elsewhere = AgentSession {
            user_id: 1,
            title: "Other".into(),
            workspace_root: "/elsewhere".into(),
            ..Default::default()
        };
        rows::insert(&conn, &elsewhere).unwrap_or_else(|err| panic!("{err}"));
    }
    mirror(workspace.path(), source)
        .export()
        .unwrap_or_else(|err| panic!("{err}"));

    let dir = workspace.path().join(".kition/agents/1");
    let snapshot: Value =
        serde_json::from_slice(&std::fs::read(dir.join("session.json")).unwrap_or_default())
            .unwrap_or_default();
    assert_eq!(snapshot["schema_version"], json!(3));
    assert_eq!(snapshot["events_count"], json!(3));
    assert_eq!(snapshot["session"]["workspace_root"], json!("."));
    let lines: Vec<Value> = std::fs::read_to_string(dir.join("session-events.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_default())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(
        lines[0],
        json!({ "seq": 0, "at": 100, "type": "turn/start", "turn": 1 })
    );
    assert_eq!(lines[2]["content"], "Hello");
    assert!(lines[2].get("rawItems").is_none(), "{}", lines[2]);
    assert!(!dir.join("messages.jsonl").exists());
    assert!(!workspace.path().join(".kition/agents/2").exists());

    let restored = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let target = mirror(workspace.path(), restored.clone());
    for _ in 0..2 {
        target
            .import_agent_state()
            .unwrap_or_else(|err| panic!("{err}"));
    }
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
            (0, 100, json!({ "type": "turn/start", "turn": 1 })),
            (1, 101, user),
            (2, 102, stripped),
        ],
        "imported once, without provider-native items"
    );
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

fn session_in(conn: &rusqlite::Connection, root: &str) -> i64 {
    let session = AgentSession {
        user_id: 1,
        title: "Plan".into(),
        workspace_root: root.into(),
        ..Default::default()
    };
    rows::insert(conn, &session).unwrap_or_else(|err| panic!("{err}"))
}

fn exported_lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_default())
        .collect()
}

#[test]
fn exports_the_log_without_inline_images_or_system_prompts() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = workspace.path().to_string_lossy().into_owned();
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    {
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let key = format!("agent:{}", session_in(&conn, &root));
        append(&conn, &key, 0, &json!({ "type": "turn/start", "turn": 1 }));
        append(
            &conn,
            &key,
            1,
            &json!({ "type": "system/message", "content": "You are Kition." }),
        );
        append(
            &conn,
            &key,
            2,
            &json!({ "type": "user/message", "source": { "kind": "user" }, "content": [
            { "type": "text", "text": "What is this?" },
            { "type": "image", "url": "data:image/png;base64,AAAA" },
            { "type": "image", "url": "/uploads/a.png" },
        ] }),
        );
        append(
            &conn,
            &key,
            3,
            &json!({ "type": "tool/result", "callId": "c1", "name": "image_read", "isError": false,
            "content": [{ "type": "image", "url": "data:image/jpeg;base64,BBBB" }] }),
        );
    }
    mirror(workspace.path(), db)
        .export()
        .unwrap_or_else(|err| panic!("{err}"));

    let path = workspace
        .path()
        .join(".kition/agents/1/session-events.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(!text.contains("data:"), "{text}");
    let lines = exported_lines(&path);
    let seqs: Vec<_> = lines.iter().map(|line| line["seq"].clone()).collect();
    assert_eq!(
        seqs,
        [json!(0), json!(2), json!(3)],
        "system/message is not exported"
    );
    let omitted = json!({ "type": "text", "text": "[image omitted]" });
    assert_eq!(
        lines[1]["content"],
        json!([{ "type": "text", "text": "What is this?" }, omitted, { "type": "image", "url": "/uploads/a.png" }])
    );
    assert_eq!(lines[2]["content"], json!([omitted]));
}

#[test]
fn an_unchanged_session_is_not_rewritten() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = workspace.path().to_string_lossy().into_owned();
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let key = {
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let key = format!("agent:{}", session_in(&conn, &root));
        append(&conn, &key, 0, &json!({ "type": "turn/start", "turn": 1 }));
        key
    };
    let target = mirror(workspace.path(), db.clone());
    target.export().unwrap_or_else(|err| panic!("{err}"));
    let dir = workspace.path().join(".kition/agents/1");
    // Marks the files so a rewrite shows; an unchanged log keeps them.
    std::fs::write(dir.join("session-events.jsonl"), "marker\n")
        .unwrap_or_else(|err| panic!("{err}"));
    let modified = |name: &str| {
        std::fs::metadata(dir.join(name))
            .and_then(|meta| meta.modified())
            .unwrap_or_else(|err| panic!("{err}"))
    };
    let session_written = modified("session.json");
    target.export().unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        std::fs::read_to_string(dir.join("session-events.jsonl")).unwrap_or_default(),
        "marker\n"
    );
    assert_eq!(modified("session.json"), session_written);

    {
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        append(
            &conn,
            &key,
            1,
            &json!({ "type": "turn/end", "turn": 1, "reason": "completed" }),
        );
    }
    target.export().unwrap_or_else(|err| panic!("{err}"));
    let seqs: Vec<_> = exported_lines(&dir.join("session-events.jsonl"))
        .iter()
        .map(|line| line["seq"].clone())
        .collect();
    assert_eq!(seqs, [json!(0), json!(1)], "a grown log is written again");
}

#[test]
fn a_damaged_session_is_skipped_and_the_rest_imported() {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let agents = workspace.path().join(".kition/agents");
    let session = |id: i64| {
        json!({ "schema_version": 3, "session": { "id": id, "user_id": 1, "title": format!("S{id}"),
            "workspace_root": ".", "created_at": 1, "updated_at": 1 } })
    };
    let write = |dir: &str, name: &str, text: String| {
        std::fs::create_dir_all(agents.join(dir)).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(agents.join(dir).join(name), text).unwrap_or_else(|err| panic!("{err}"));
    };
    let start = json!({ "seq": 0, "at": 1, "type": "turn/start", "turn": 1 }).to_string();
    // Session 1: a malformed log line. Session 2: an event without seq.
    // Session 3: a malformed session.json. Session 4: intact.
    write("1", "session.json", session(1).to_string());
    write("1", "session-events.jsonl", format!("{start}\n{{\n"));
    write("2", "session.json", session(2).to_string());
    write(
        "2",
        "session-events.jsonl",
        format!("{start}\n{}\n", json!({ "type": "turn/end" })),
    );
    write("3", "session.json", "{".into());
    write("4", "session.json", session(4).to_string());
    write("4", "session-events.jsonl", format!("{start}\n"));

    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    mirror(workspace.path(), db.clone())
        .import_agent_state()
        .unwrap_or_else(|err| panic!("{err}"));
    let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
    let imported: Vec<i64> = (1..=4)
        .filter(|id| {
            rows::find::<AgentSession>(&conn, *id)
                .ok()
                .flatten()
                .is_some()
        })
        .collect();
    assert_eq!(imported, [4], "a damaged session is skipped whole");
    assert_eq!(logged(&conn, "agent:4").len(), 1);
    assert!(logged(&conn, "agent:1").is_empty() && logged(&conn, "agent:2").is_empty());
}
