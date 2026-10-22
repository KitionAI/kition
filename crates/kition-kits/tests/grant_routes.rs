//! `/kits/grants` (Kit Standard `KitFiles 1.0`): sessions, handles, reads, staged writes, and
//! releases, and the refusals: rights a handle lacks, expired and foreign handles, files that
//! exist, paths outside the workspace or hidden, and requests not addressed to a loopback host.
//! No kit executable is needed.

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_http::AuthConfig;
use kition_kits::grants::{Flow, GrantLimits, GrantRequest, Kind, Right, SessionRequest};
use kition_kits::{KitManager, KitsState, router};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "grant-routes-test-token";

struct Fixture {
    app: Router,
    kits: KitManager,
    dir: tempfile::TempDir,
    _outside: tempfile::TempDir,
}

fn write(path: &std::path::Path, bytes: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
    }
    std::fs::write(path, bytes).unwrap_or_else(|err| panic!("{err}"));
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let outside = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = dir.path();
    write(&root.join("art/note.mockdoc"), "the document");
    write(&root.join("art/photo.png"), "0123456789");
    write(&root.join("art/notes.txt"), "plain");
    write(&root.join("art/out.png"), "taken");
    write(&root.join("art/.secret.png"), "hidden");
    write(&root.join(".kition/state.png"), "store");
    write(&root.join("batch/one.png"), "one");
    write(&root.join("batch/two.png"), "two");
    write(&root.join("batch/skip.txt"), "skip");
    write(&root.join("batch/.hidden.png"), "hidden");
    write(&outside.path().join("private.png"), "outside");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = |target: &std::path::Path, at: &str| {
            symlink(target, root.join(at)).unwrap_or_else(|err| panic!("{err}"));
        };
        link(&outside.path().join("private.png"), "art/escape.png");
        link(outside.path(), "away");
        link(&root.join(".kition/state.png"), "art/store.png");
        link(&outside.path().join("private.png"), "batch/three.png");
    }
    let kits = KitManager::new(Some(root.to_path_buf()), Vec::new());
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let auth = AuthConfig {
        db,
        jwt_secret: "test".into(),
        disabled: true,
    };
    // The same transport guard the runtime puts in front of every route: the origin checks and
    // the API token gate.
    let app = kition_http::guard(
        router(KitsState {
            auth,
            kits: kits.clone(),
        }),
        kition_http::gate::ApiGate::new(TOKEN, ""),
        kition_http::cors::CorsPolicy::default(),
    );
    Fixture {
        app,
        kits,
        dir,
        _outside: outside,
    }
}

/// Validates a response against one `$defs` entry of `contracts/runtime/kits.schema.json`.
fn check_contract(def: &str, instance: &Value) {
    let mut schema: Value =
        serde_json::from_str(include_str!("../../../contracts/runtime/kits.schema.json"))
            .unwrap_or_else(|err| panic!("{err}"));
    schema["$ref"] = json!(format!("#/$defs/{def}"));
    let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"));
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| format!("{error} at {}", error.instance_path()))
        .collect();
    assert!(
        errors.is_empty(),
        "{def}: {}\n{instance}",
        errors.join("; ")
    );
}

struct Answer {
    status: StatusCode,
    json: Value,
    bytes: Vec<u8>,
    headers: http::HeaderMap,
}

impl Answer {
    fn data(&self) -> &Value {
        &self.json["data"]
    }

    fn reason(&self) -> &Value {
        &self.json["data"]["reason"]
    }
}

/// Sends `request` as Kition's renderer does, with the API token.
async fn send(app: &Router, mut request: Request<Body>) -> Answer {
    request.headers_mut().insert(
        kition_http::gate::TOKEN_HEADER,
        http::HeaderValue::from_static(TOKEN),
    );
    send_as_is(app, request).await
}

async fn send_as_is(app: &Router, request: Request<Body>) -> Answer {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap_or_else(|err| panic!("{err}"))
        .to_bytes()
        .to_vec();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Answer {
        status,
        json,
        bytes,
        headers,
    }
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> Answer {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:34115")
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap_or_else(|err| panic!("{err}"));
    send(app, request).await
}

async fn put(app: &Router, uri: &str, bytes: &'static str) -> Answer {
    let request = Request::builder()
        .method("PUT")
        .uri(uri)
        .header("host", "localhost:34115")
        .header("content-type", "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap_or_else(|err| panic!("{err}"));
    send(app, request).await
}

fn manifest() -> Value {
    json!({ "read": ["png", "mockdoc"], "create": ["png"], "folders": true })
}

async fn open_session(app: &Router, extra: Value) -> String {
    let mut body =
        json!({ "kit": "kit.mock", "document": "art/note.mockdoc", "files": manifest() });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }
    let answer = call(app, "POST", "/kits/grants/sessions", Some(body)).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    check_contract("grantSession", answer.data());
    answer.data()["session"]
        .as_str()
        .unwrap_or_else(|| panic!("no session"))
        .to_owned()
}

async fn grant(app: &Router, session: &str, path: &str, kind: &str, rights: Value) -> Answer {
    call(
        app,
        "POST",
        "/kits/grants",
        Some(json!({ "session": session, "path": path, "kind": kind, "rights": rights, "flow": "pick" })),
    )
    .await
}

fn handle_of(answer: &Answer) -> String {
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    check_contract("fileStat", answer.data());
    answer.data()["handle"]
        .as_str()
        .unwrap_or_else(|| panic!("no handle"))
        .to_owned()
}

/// Every answer names files by display name only: no workspace path, no absolute path.
fn assert_no_paths(fixture: &Fixture, answer: &Answer) {
    let text = answer.json.to_string();
    let root = fixture.dir.path().to_string_lossy().into_owned();
    assert!(!text.contains(&root), "a path leaked: {text}");
    assert!(!text.contains("art/"), "a workspace path leaked: {text}");
}

#[tokio::test]
async fn grants_read_list_create_and_write_files() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;

    // A picked file: stat and ranged reads.
    let picked = grant(app, &session, "art/photo.png", "file", json!(["read"])).await;
    assert_no_paths(&fixture, &picked);
    assert_eq!(picked.data()["name"], "photo.png");
    assert_eq!(picked.data()["size"], 10);
    let photo = handle_of(&picked);
    let stat = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}?session={session}"),
        None,
    )
    .await;
    check_contract("fileStat", stat.data());
    let read = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}/content?session={session}&offset=2&length=5"),
        None,
    )
    .await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.bytes, b"23456");
    assert_eq!(read.headers["kition-file-size"], "10");
    assert_eq!(
        read.headers["etag"],
        stat.data()["version"].as_str().unwrap_or_default()
    );

    // A picked folder lists the visible files it accepts, links out of the workspace skipped.
    let folder =
        handle_of(&grant(app, &session, "batch", "folder", json!(["read", "create"])).await);
    let listed = call(
        app,
        "GET",
        &format!("/kits/grants/{folder}/list?session={session}"),
        None,
    )
    .await;
    check_contract("fileList", listed.data());
    assert_no_paths(&fixture, &listed);
    let names: Vec<&str> = listed.data()["files"]
        .as_array()
        .unwrap_or_else(|| panic!("no files"))
        .iter()
        .filter_map(|file| file["name"].as_str())
        .collect();
    assert_eq!(names, ["one.png", "two.png"]);

    // files/create beside the document picks an unused name, and the file appears on commit.
    let created = call(
        app,
        "POST",
        "/kits/grants/create",
        Some(json!({ "session": session, "suggestedName": "../out.png", "mime": "image/png" })),
    )
    .await;
    assert_eq!(created.data()["name"], "out 2.png");
    assert_eq!(created.data()["version"], Value::Null);
    let out = handle_of(&created);
    let new_file = fixture.dir.path().join("art/out 2.png");
    let chunk = put(
        app,
        &format!("/kits/grants/{out}/content?session={session}&offset=0"),
        "hello ",
    )
    .await;
    assert_eq!(chunk.status, StatusCode::OK, "{}", chunk.json);
    check_contract("writeChunkResult", chunk.data());
    assert!(!new_file.exists(), "a staged write is not visible");
    let last = put(
        app,
        &format!("/kits/grants/{out}/content?session={session}&offset=6&final=true"),
        "world",
    )
    .await;
    assert_eq!(last.status, StatusCode::OK, "{}", last.json);
    check_contract("writeChunkResult", last.data());
    assert!(last.data()["version"].is_string());
    assert_eq!(
        std::fs::read_to_string(&new_file).unwrap_or_default(),
        "hello world"
    );

    // files/create in the granted folder.
    let into = call(
        app,
        "POST",
        "/kits/grants/create",
        Some(json!({ "session": session, "suggestedName": "one.png", "folder": folder })),
    )
    .await;
    assert_eq!(into.data()["name"], "one 2.png");

    // A picked file to replace: write with the version read.
    let target = handle_of(
        &grant(
            app,
            &session,
            "art/out.png",
            "file",
            json!(["read", "write"]),
        )
        .await,
    );
    let version = call(
        app,
        "GET",
        &format!("/kits/grants/{target}?session={session}"),
        None,
    )
    .await
    .data()["version"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let replaced = put(
        app,
        &format!(
            "/kits/grants/{target}/content?session={session}&offset=0&final=true&expected={}",
            urlencode(&version)
        ),
        "replaced",
    )
    .await;
    assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.json);
    assert_eq!(
        std::fs::read_to_string(fixture.dir.path().join("art/out.png")).unwrap_or_default(),
        "replaced"
    );

    // The session shows its grants and logs every grant and commit (FA16, section 7).
    let view = call(
        app,
        "GET",
        &format!("/kits/grants/sessions/{session}"),
        None,
    )
    .await;
    check_contract("grantSessionView", view.data());
    // Kition's own view names the document; the grants and the log name display names only.
    for part in ["grants", "log"] {
        let only = Answer {
            json: view.data()[part].clone(),
            ..call(
                app,
                "GET",
                &format!("/kits/grants/sessions/{session}"),
                None,
            )
            .await
        };
        assert_no_paths(&fixture, &only);
    }
    assert_eq!(view.data()["document"], "art/note.mockdoc");
    let events: Vec<&str> = view.data()["log"]
        .as_array()
        .unwrap_or_else(|| panic!("no log"))
        .iter()
        .filter_map(|entry| entry["event"].as_str())
        .collect();
    assert_eq!(events.iter().filter(|event| **event == "commit").count(), 2);
    assert!(events.iter().filter(|event| **event == "grant").count() >= 6);

    // Released and ended: every handle stops working.
    let released = call(
        app,
        "POST",
        "/kits/grants/release",
        Some(json!({ "session": session, "handles": [photo, "fh_00000000000000000000000000000000"] })),
    )
    .await;
    assert_eq!(released.status, StatusCode::OK);
    let gone = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}?session={session}"),
        None,
    )
    .await;
    assert_eq!(gone.status, StatusCode::FORBIDDEN);
    assert_eq!(gone.reason(), "file-not-granted");
    let ended = call(
        app,
        "DELETE",
        &format!("/kits/grants/sessions/{session}"),
        None,
    )
    .await;
    check_contract("grantSessionEnd", ended.data());
    assert!(
        ended.data()["revoked"]
            .as_array()
            .is_some_and(|handles| handles.len() >= 5)
    );
    let after = call(
        app,
        "GET",
        &format!("/kits/grants/{folder}/list?session={session}"),
        None,
    )
    .await;
    assert_eq!(after.reason(), "file-not-granted");
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[tokio::test]
async fn refuses_rights_a_handle_lacks() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let other = open_session(app, json!({})).await;
    let photo = handle_of(&grant(app, &session, "art/photo.png", "file", json!(["read"])).await);

    // A read handle writes nothing.
    let write = put(
        app,
        &format!("/kits/grants/{photo}/content?session={session}&offset=0&final=true&expected=x"),
        "x",
    )
    .await;
    assert_eq!(write.status, StatusCode::FORBIDDEN);
    assert_eq!(write.reason(), "file-not-granted");
    // A file handle lists nothing.
    let list = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}/list?session={session}"),
        None,
    )
    .await;
    assert_eq!(list.reason(), "file-not-granted");
    // Another session's handle is foreign (FA5).
    let foreign = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}/content?session={other}"),
        None,
    )
    .await;
    assert_eq!(foreign.status, StatusCode::FORBIDDEN);
    assert_eq!(foreign.reason(), "file-not-granted");
    // A create handle reads nothing.
    let created = handle_of(
        &call(
            app,
            "POST",
            "/kits/grants/create",
            Some(json!({ "session": session, "suggestedName": "new.png" })),
        )
        .await,
    );
    let read = call(
        app,
        "GET",
        &format!("/kits/grants/{created}/content?session={session}"),
        None,
    )
    .await;
    assert_eq!(read.reason(), "file-not-granted");
    // A file handle is no folder to create in.
    let into = call(
        app,
        "POST",
        "/kits/grants/create",
        Some(json!({ "session": session, "suggestedName": "a.png", "folder": photo })),
    )
    .await;
    assert_eq!(into.reason(), "file-not-granted");

    // The manifest bounds what a kit may ask for (K15).
    let text = grant(app, &session, "art/notes.txt", "file", json!(["read"])).await;
    assert_eq!(text.status, StatusCode::FORBIDDEN);
    assert_eq!(text.reason(), "not-allowed");
    let export = call(
        app,
        "POST",
        "/kits/grants/create",
        Some(json!({ "session": session, "suggestedName": "a.txt" })),
    )
    .await;
    assert_eq!(export.reason(), "not-allowed");
    let no_folders = open_session(app, json!({ "files": { "read": ["png"] } })).await;
    let folder = grant(app, &no_folders, "batch", "folder", json!(["read"])).await;
    assert_eq!(folder.reason(), "not-allowed");
    let nothing = open_session(app, json!({ "files": {} })).await;
    let refused = grant(app, &nothing, "art/photo.png", "file", json!(["read"])).await;
    assert_eq!(refused.reason(), "not-allowed");

    // A read-only session replaces no file (FA17), but still creates.
    let read_only = open_session(app, json!({ "readOnly": true })).await;
    let replace = grant(app, &read_only, "art/out.png", "file", json!(["write"])).await;
    assert_eq!(replace.reason(), "not-allowed");
    let export = call(
        app,
        "POST",
        "/kits/grants/create",
        Some(json!({ "session": read_only, "suggestedName": "copy.png" })),
    )
    .await;
    assert_eq!(export.status, StatusCode::OK);

    // An agent replaces a file only through a draft or the person's approval (FA13).
    let grants = fixture.kits.grants();
    let principal = "user:1";
    let agent = grants
        .open_session(SessionRequest {
            kit: "kit.mock",
            principal,
            document: None,
            manifest: serde_json::from_value(manifest()).unwrap_or_default(),
            read_only: false,
        })
        .unwrap_or_else(|err| panic!("{err}"));
    let request = |approved| GrantRequest {
        path: "art/out.png",
        kind: Kind::File,
        rights: &[Right::Write],
        accept: &[],
        flow: Flow::Agent,
        approved,
    };
    let unapproved = grants.grant(&agent, principal, request(false));
    assert!(
        matches!(unapproved, Err(ref error) if error.reason() == Some("not-allowed")),
        "{unapproved:?}"
    );
    assert!(grants.grant(&agent, principal, request(true)).is_ok());
    // Another person holds none of it.
    let stranger = grants.view(&agent, "user:2");
    assert!(matches!(stranger, Err(ref error) if error.reason() == Some("file-not-granted")));
}

#[tokio::test]
async fn handles_expire_with_their_session() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let photo = handle_of(&grant(app, &session, "art/photo.png", "file", json!(["read"])).await);
    let created = handle_of(
        &call(
            app,
            "POST",
            "/kits/grants/create",
            Some(json!({ "session": session, "suggestedName": "late.png" })),
        )
        .await,
    );
    let staged = put(
        app,
        &format!("/kits/grants/{created}/content?session={session}&offset=0"),
        "part",
    )
    .await;
    assert_eq!(staged.status, StatusCode::OK);
    // Nobody uses the session now; a short idle limit, set after the setup so a slow machine
    // cannot expire it early, ends it.
    fixture.kits.grants().set_limits(GrantLimits {
        idle: Duration::from_millis(50),
        ..GrantLimits::default()
    });
    tokio::time::sleep(Duration::from_millis(200)).await;

    let expired = call(
        app,
        "GET",
        &format!("/kits/grants/{photo}/content?session={session}"),
        None,
    )
    .await;
    assert_eq!(expired.status, StatusCode::FORBIDDEN);
    assert_eq!(expired.reason(), "file-not-granted");
    let finish = put(
        app,
        &format!("/kits/grants/{created}/content?session={session}&offset=4&final=true"),
        "!",
    )
    .await;
    assert_eq!(finish.reason(), "file-not-granted");
    // The expired write left nothing behind: no file, no staging file.
    let leftovers: Vec<String> = std::fs::read_dir(fixture.dir.path().join("art"))
        .unwrap_or_else(|err| panic!("{err}"))
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("late"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let unknown = call(
        app,
        "GET",
        "/kits/grants/sessions/fs_00000000000000000000000000000000",
        None,
    )
    .await;
    assert_eq!(unknown.reason(), "file-not-granted");
}

#[tokio::test]
async fn never_replaces_an_existing_file_without_its_version() {
    let fixture = fixture();
    let app = &fixture.app;
    let root = fixture.dir.path();
    let session = open_session(app, json!({})).await;

    // A create grant on a file that exists is refused (H5).
    let taken = grant(app, &session, "art/out.png", "file", json!(["create"])).await;
    assert_eq!(taken.status, StatusCode::CONFLICT);
    assert_eq!(taken.reason(), "conflict");

    // A picked new name taken before the commit: conflict, and the file stays.
    let picked =
        handle_of(&grant(app, &session, "art/picked.png", "file", json!(["create"])).await);
    write(&root.join("art/picked.png"), "someone else");
    let commit = put(
        app,
        &format!("/kits/grants/{picked}/content?session={session}&offset=0&final=true"),
        "mine",
    )
    .await;
    assert_eq!(commit.reason(), "conflict");
    assert_eq!(
        std::fs::read_to_string(root.join("art/picked.png")).unwrap_or_default(),
        "someone else"
    );

    // A files/create name taken before the commit moves on to the next unused name.
    let created = handle_of(
        &call(
            app,
            "POST",
            "/kits/grants/create",
            Some(json!({ "session": session, "suggestedName": "race.png" })),
        )
        .await,
    );
    write(&root.join("art/race.png"), "first");
    let moved = put(
        app,
        &format!("/kits/grants/{created}/content?session={session}&offset=0&final=true"),
        "second",
    )
    .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.json);
    assert_eq!(
        std::fs::read_to_string(root.join("art/race.png")).unwrap_or_default(),
        "first"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("art/race 2.png")).unwrap_or_default(),
        "second"
    );
    let stat = call(
        app,
        "GET",
        &format!("/kits/grants/{created}?session={session}"),
        None,
    )
    .await;
    assert_eq!(stat.data()["name"], "race 2.png");
    // A create handle commits once.
    let again = put(
        app,
        &format!("/kits/grants/{created}/content?session={session}&offset=0&final=true"),
        "third",
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.reason(), "already-committed");

    // A write handle needs the version it replaces, and a stale one is a conflict.
    let target = handle_of(&grant(app, &session, "art/out.png", "file", json!(["write"])).await);
    let bare = put(
        app,
        &format!("/kits/grants/{target}/content?session={session}&offset=0&final=true"),
        "x",
    )
    .await;
    assert_eq!(bare.reason(), "conflict");
    let stale = put(
        app,
        &format!("/kits/grants/{target}/content?session={session}&offset=0&final=true&expected=%22stale%22"),
        "x",
    )
    .await;
    assert_eq!(stale.reason(), "conflict");
    assert_eq!(
        std::fs::read_to_string(root.join("art/out.png")).unwrap_or_default(),
        "taken"
    );

    // Chunks come in order.
    let out_of_order = put(
        app,
        &format!("/kits/grants/{target}/content?session={session}&offset=5"),
        "x",
    )
    .await;
    assert_eq!(out_of_order.status, StatusCode::BAD_REQUEST);
    assert_eq!(*out_of_order.reason(), Value::Null);
}

#[tokio::test]
async fn refuses_paths_outside_the_workspace_the_same_way() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let mut refused = vec![
        "../outside.png",
        "art/../../outside.png",
        "/etc/hosts",
        "art\\photo.png",
        ".kition/state.png",
        ".kition/missing.png",
        "art/.secret.png",
        "art/.missing.png",
        "missing/photo.png",
        "art/missing.png",
    ];
    if cfg!(unix) {
        // Links out of the workspace, and into its hidden store.
        refused.extend(["art/escape.png", "away/private.png", "art/store.png"]);
    }
    for path in refused {
        let answer = grant(app, &session, path, "file", json!(["read"])).await;
        assert_eq!(
            answer.status,
            StatusCode::FORBIDDEN,
            "{path}: {}",
            answer.json
        );
        assert_eq!(answer.reason(), "not-allowed", "{path}");
        assert_eq!(
            answer.json["message"], "this file is not available to the kit",
            "{path} is refused the same way whether it exists or not"
        );
    }
    for path in [
        "../new.png",
        ".kition/new.png",
        "away/new.png",
        "art/.new.png",
    ] {
        let answer = grant(app, &session, path, "file", json!(["create"])).await;
        assert_eq!(answer.reason(), "not-allowed", "{path}");
    }
    if cfg!(unix) {
        let away = grant(app, &session, "away", "folder", json!(["read"])).await;
        assert_eq!(away.reason(), "not-allowed");
    }
    // A session's document is confined too.
    let outside = call(
        app,
        "POST",
        "/kits/grants/sessions",
        Some(json!({ "kit": "kit.mock", "document": "../note.mockdoc", "files": manifest() })),
    )
    .await;
    assert_eq!(outside.reason(), "not-allowed");

    // A file granted inside that later becomes a link out of the workspace is no longer read.
    #[cfg(unix)]
    {
        let root = fixture.dir.path();
        write(&root.join("art/notes.png"), "inside");
        let photo =
            handle_of(&grant(app, &session, "art/notes.png", "file", json!(["read"])).await);
        std::fs::remove_file(root.join("art/notes.png")).unwrap_or_else(|err| panic!("{err}"));
        std::os::unix::fs::symlink(
            fixture._outside.path().join("private.png"),
            root.join("art/notes.png"),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        let read = call(
            app,
            "GET",
            &format!("/kits/grants/{photo}/content?session={session}"),
            None,
        )
        .await;
        assert_eq!(read.reason(), "not-allowed");
        assert!(read.bytes.len() < 200, "no file bytes in a refusal");
    }
}

#[tokio::test]
async fn refuses_requests_not_addressed_to_a_loopback_host() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    for host in ["evil.example", "evil.example:34115", "192.168.1.20:34115"] {
        let request = Request::builder()
            .method("POST")
            .uri("/kits/grants")
            .header("host", host)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "session": session, "path": "art/photo.png", "kind": "file", "rights": ["read"], "flow": "pick" })
                    .to_string(),
            ))
            .unwrap_or_else(|err| panic!("{err}"));
        let answer = send(app, request).await;
        assert_eq!(answer.status, StatusCode::FORBIDDEN, "{host}");
        assert!(
            answer.json.is_null(),
            "no grant for {host}: {}",
            answer.json
        );
    }
    let view = call(
        app,
        "GET",
        &format!("/kits/grants/sessions/{session}"),
        None,
    )
    .await;
    assert_eq!(view.data()["grants"], json!([]));
}

#[tokio::test]
async fn refuses_every_grant_route_without_the_api_token() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let granted = grant(
        app,
        &session,
        "art/photo.png",
        "file",
        json!(["read", "write"]),
    )
    .await;
    let handle = handle_of(&granted);
    let attempts = [
        ("POST", "/kits/grants/sessions".to_owned(), json!({ "kit": "kit.mock" }).to_string()),
        (
            "POST",
            "/kits/grants".to_owned(),
            json!({ "session": session, "path": "art/notes.txt", "kind": "file", "rights": ["read"], "flow": "pick" }).to_string(),
        ),
        ("GET", format!("/kits/grants/{handle}?session={session}"), String::new()),
        ("GET", format!("/kits/grants/{handle}/content?session={session}"), String::new()),
        ("PUT", format!("/kits/grants/{handle}/content?session={session}&offset=0"), "x".to_owned()),
        ("GET", format!("/kits/grants/sessions/{session}"), String::new()),
        ("DELETE", format!("/kits/grants/sessions/{session}"), String::new()),
    ];
    for (method, uri, body) in attempts {
        for token in [None, Some("wrong")] {
            let mut request = Request::builder()
                .method(method)
                .uri(&uri)
                .header("content-type", "application/json");
            if let Some(token) = token {
                request = request.header(kition_http::gate::TOKEN_HEADER, token);
            }
            let request = request
                .body(Body::from(body.clone()))
                .unwrap_or_else(|err| panic!("{err}"));
            let answer = send_as_is(app, request).await;
            assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
            assert_eq!(answer.reason(), "api_token", "{method} {uri}");
        }
    }
    // Nothing changed: the session is open with its one grant, and the file is as it was.
    let view = call(
        app,
        "GET",
        &format!("/kits/grants/sessions/{session}"),
        None,
    )
    .await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(view.data()["grants"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        std::fs::read_to_string(fixture.dir.path().join("art/photo.png")).unwrap_or_default(),
        "0123456789"
    );
}
