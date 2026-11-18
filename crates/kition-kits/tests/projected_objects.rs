// Copied from kition-sdk crates/kition-kits/tests/projected_objects.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(unix)]
use kition_kits::{KitDefinition, KitManager, tools};
use serde_json::{Value, json};

#[path = "support/binary.rs"]
mod binary;

#[path = "support/editor.rs"]
mod editor;

const DOCUMENT: &str = "#s=Intro\na=Alpha\nb=Beta\n#t=More\nc=Gamma";

struct Fixture {
    kits: KitManager,
    native: KitManager,
    dir: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self::with_places("", DOCUMENT)
    }
    fn with_places(place: &str, contents: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let mock = binary::mock_binary().expect("build mock first");
        assert!(mock.is_file(), "build mock first");
        let script = bin.path().join("mock");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.projected:projected KITION_KIT_MOCK_PROJECTED=1 KITION_KIT_MOCK_PROJECTED_PLACE='{place}' KITION_KIT_MOCK_BATCH=commands exec '{}' \"$@\"\n",
                mock.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let kit=KitDefinition::from_manifest(&json!({"khp":"1.0","id":"kit.projected","name":"Projected","version":"0.0.0","formats":[{"id":"projected","extensions":["projected"],"role":"edit"}],"agent":{"prefix":"projected","tools":"document","objectModel":true},"headless":{"executable":"mock","protocol":"kition-kit/2"}})).unwrap();
        std::fs::write(dir.path().join("a.projected"), contents).unwrap();
        let kits = KitManager::new(Some(dir.path().to_owned()), vec![(kit, Some(script.clone()))]);
        let native = editor::attach(&kits, dir.path(), kit, &script, "a.projected");
        Self { kits, native, dir, _bin: bin }
    }

    fn file(&self) -> std::path::PathBuf {
        self.dir.path().join("a.projected")
    }

    async fn call(&self, principal: &str, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!("a.projected");
        match tools::call_as(&self.kits, &format!("projected_{action}"), &input, Default::default(), principal).await.unwrap() {
            Ok(out) => Ok(out.output),
            Err(error) => Err(error.structured()),
        }
    }
}

#[tokio::test]
async fn nested_projected_ref_assignment_uses_the_child_mapping() {
    let f = Fixture::with_places("ref", "#s=Intro\na=Alpha\n#t=More");
    let basis = f.call("me", "query", json!({})).await.unwrap()["revision"].clone();
    let result = f.call("me", "batch", json!({"basis":basis,"ops":[{"op":"set","target":"section:t","field":"lines","value":"line:a"}]})).await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(std::fs::read_to_string(f.file()).unwrap(), "#s=Intro\n#t=More\na=Alpha");
    f.kits.shutdown().await;
    f.native.shutdown().await;
}

#[tokio::test]
async fn nested_projected_tree_and_ref_premises_refuse_only_the_held_content() {
    for place in ["tree", "ref"] {
        for outside in [false, true] {
            for held in [false, true] {
                let f = Fixture::with_places(place, "#s=Intro\na=Alpha\n#t=More\nc=Gamma");
                let basis = f.call("me", "query", json!({})).await.unwrap()["revision"].clone();
                let id = if held { "line:a" } else { "line:c" };
                if outside {
                    std::fs::write(f.file(), if held { "#s=Intro\na=Colleague\n#t=More\nc=Gamma" } else { "#s=Intro\na=Alpha\n#t=More\nc=Colleague" }).unwrap();
                } else {
                    f.call("other", "run", json!({"steps":[{"command":"line.set","params":{"id":id,"text":"Colleague"}}]})).await.unwrap();
                }
                let before = std::fs::read(f.file()).unwrap();
                let result = f.call("me", "batch", json!({"basis":basis,"ops":[{"op":"set","target":"line:a","field":"text","value":"Agent"}]})).await;
                if held {
                    let error = result.unwrap_err();
                    assert_eq!(error["conflicts"][0]["reason"], "changed", "{error}");
                    assert_eq!(std::fs::read(f.file()).unwrap(), before);
                } else {
                    assert!(result.is_ok(), "{place}: {result:?}");
                }
                f.kits.shutdown().await;
                f.native.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn unsaved_human_projection_changes_are_guarded_in_the_editor() {
    if std::env::var("KITION_TEST_READER").as_deref() != Ok("editor") {
        return;
    }
    for (target, expected) in [("line:a", Some("changed")), ("line:b", None)] {
        let f = Fixture::new();
        let basis = f.call("me", "query", json!({})).await.unwrap()["revision"].clone();
        let document = f.native.open(kition_kits::manager::Caller::User, "a.projected").await.unwrap();
        f.native
            .execute(
                kition_kits::manager::Caller::User,
                "kit.projected",
                &document.document_id,
                "line.set",
                json!({"id":target,"text":"Human"}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(f.file()).unwrap(), DOCUMENT, "the human edit must remain unsaved");
        let result = f.call("me", "run", json!({"basis":basis,"steps":[{"command":"line.set","params":{"id":"line:a","text":"Agent"}}]})).await;
        match expected {
            Some(reason) => assert_eq!(result.unwrap_err()["conflicts"][0]["reason"], reason),
            None => assert!(result.is_ok(), "{result:?}"),
        }
        f.kits.shutdown().await;
        f.native.shutdown().await;
    }
}

#[tokio::test]
async fn query_exposes_lines_and_sections_computed_from_one_stored_text() {
    let f = Fixture::new();
    let result = f.call("me", "query", json!({"objects":["line:a","section:s"],"describe":"*"})).await.unwrap();
    assert_eq!(result["objects"][0]["fields"]["text"], "Alpha", "{result}");
    assert_eq!(result["objects"][1]["fields"]["lines"], json!(["line:a", "line:b"]), "{result}");
    assert!(kition_kits::drafts::schema_of(&result["describe"]).unwrap().types["Line"].projected);
    assert_eq!(std::fs::read_to_string(f.file()).unwrap(), DOCUMENT);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn projected_batch_creation_binds_ids_and_moves_between_containers() {
    let f = Fixture::new();
    let answer = f
        .call(
            "me",
            "batch",
            json!({"ops":[
        {"op":"create","type":"Line","in":"section:s.lines","ref":"$new","fields":{"text":"Created"}},
        {"op":"set","target":"$new","field":"text","value":"Bound"},
        {"op":"list.move","target":"$new","in":"section:t.lines","to":0}
    ],"load":[{"target":"$new"},{"target":"section:t"}]}),
        )
        .await
        .unwrap();
    assert_eq!(answer["loaded"][0]["fields"]["text"], "Bound", "{answer}");
    assert_eq!(answer["loaded"][1]["fields"]["lines"][0], answer["refs"]["$new"], "{answer}");
    f.kits.shutdown().await;
}

#[tokio::test]
async fn virtual_lists_on_projected_parents_route_to_the_child_type() {
    let f = Fixture::new();
    let answer = f
        .call(
            "me",
            "batch",
            json!({"ops":[{"op":"list.move","target":"section:s","field":"lines","from":0,"to":1}],"load":[{"target":"root"},{"target":"section:s"}]}),
        )
        .await
        .unwrap();
    assert_eq!(answer["loaded"][0]["fields"]["sections"], json!(["section:s", "section:t"]), "{answer}");
    assert_eq!(answer["loaded"][1]["fields"]["lines"], json!(["line:b", "line:a"]), "{answer}");
    f.kits.shutdown().await;
}

#[tokio::test]
async fn projected_receipts_name_changes_and_never_store_computed_objects() {
    let f = Fixture::new();
    for (command, params, list, id) in [
        ("line.set", json!({"id":"line:a","text":"Revised"}), "changed", "line:a"),
        ("line.create", json!({"id":"line:d","text":"Delta","in":"section:s.lines"}), "created", "line:d"),
        ("line.move", json!({"id":"line:a","to":2}), "moved", "line:a"),
        ("line.delete", json!({"id":"line:b"}), "deleted", "line:b"),
    ] {
        let answer = f.call("me", "run", json!({"steps":[{"command":command,"params":params}],"changes":"all"})).await.unwrap();
        assert!(answer["changes"][list].as_array().unwrap().iter().any(|item| item["id"] == id), "{command}: {answer}");
    }
    let before = std::fs::read(f.file()).unwrap();
    let error = f.call("me", "batch", json!({"ops":[{"op":"set","target":"line:a","field":"key","value":"renamed"}]})).await.unwrap_err();
    assert!(error.to_string().contains("read-only"), "{error}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn projected_index_shifts_compact_in_others() {
    let f = Fixture::new();
    let text = format!("#s=Intro\n{}\n#t=More\nz=Last", (0..8).map(|i| format!("l{i}=Line {i}")).collect::<Vec<_>>().join("\n"));
    std::fs::write(f.file(), text).unwrap();
    let basis = f.call("me", "query", json!({})).await.unwrap()["revision"].clone();
    f.call("colleague", "run", json!({"steps":[{"command":"line.delete","params":{"id":"line:l0"}}]})).await.unwrap();
    let answer = f.call("me", "run", json!({"basis":basis,"steps":[{"command":"line.set","params":{"id":"line:z","text":"Mine"}}]})).await.unwrap();
    assert_eq!(answer["others"]["footprint"], json!([{"parent":"section:s","field":"lines","from":0,"count":7,"shift":{"index":-1}}]), "{answer}");
    f.kits.shutdown().await;
}

#[tokio::test]
async fn projected_guard_address_change_and_writer_matrix() {
    let mut cells = 0;
    for outside in [false, true] {
        for address in ["line:a", "Alpha", "#1"] {
            for change in ["same", "other", "deleted", "reordered", "moved"] {
                let f = Fixture::new();
                let basis = f.call("me", "query", json!({})).await.unwrap()["revision"].clone();
                let (command, params, text) = match change {
                    "same" => ("line.set", json!({"id":"line:a","text":"Revised"}), "#s=Intro\na=Revised\nb=Beta\n#t=More\nc=Gamma"),
                    "other" => ("line.set", json!({"id":"line:b","text":"Revised"}), "#s=Intro\na=Alpha\nb=Revised\n#t=More\nc=Gamma"),
                    "deleted" => ("line.delete", json!({"id":"line:a"}), "#s=Intro\nb=Beta\n#t=More\nc=Gamma"),
                    "reordered" => ("line.move", json!({"id":"line:a","to":1}), "#s=Intro\nb=Beta\na=Alpha\n#t=More\nc=Gamma"),
                    _ => ("line.move", json!({"id":"line:a","in":"section:t.lines","to":1}), "#s=Intro\nb=Beta\n#t=More\nc=Gamma\na=Alpha"),
                };
                if outside {
                    std::fs::write(f.file(), text).unwrap();
                } else {
                    f.call("colleague", "run", json!({"steps":[{"command":command,"params":params}]})).await.unwrap();
                }
                let before = std::fs::read(f.file()).unwrap();
                let expected = match (change, address) {
                    ("same", "line:a" | "#1") => "changed",
                    ("same", _) => "relocated",
                    ("deleted", _) => "deleted",
                    ("reordered" | "moved", "#1") => "relocated",
                    _ => "apply",
                };
                let answer = f.call("me", "run", json!({"basis":basis,"steps":[{"command":"line.set","params":{"id":address,"text":"Mine"}}]})).await;
                eprintln!("PROJECTED {outside}/{address}/{change}: {expected} {answer:?}");
                if expected == "apply" {
                    assert!(answer.is_ok(), "{outside}/{address}/{change}: {answer:?}");
                } else {
                    let error = answer.unwrap_err();
                    assert!(
                        error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == expected),
                        "{outside}/{address}/{change}: wanted {expected}: {error}"
                    );
                    assert_eq!(std::fs::read(f.file()).unwrap(), before);
                }
                cells += 1;
                f.kits.shutdown().await;
            }
        }
    }
    assert_eq!(cells, 30);
}
