// Copied from kition-sdk crates/kition-kdm/tests/reproducible_ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A document created by the same steps in a reproducible build (`SOURCE_DATE_EPOCH` set, as a
//! showcase sample or a golden case is built) saves the same bytes: new document ids, actors and
//! object ids are counted from the epoch instead of drawn at random. Each build runs in a process
//! of its own: this test starts itself several times.

mod common;

use std::path::PathBuf;
use std::process::Command;

use common::{fields, person, schema};
use kition_kdm::{ActorId, DocId, Replica};
use serde_json::json;

const OUT: &str = "KITION_KDM_REPRODUCIBLE_OUT";

fn build() -> Vec<u8> {
    let mut replica = Replica::create(schema(), DocId::new(), ActorId::random()).unwrap();
    replica
        .transact(&person(), |tx| {
            let page = tx.create("Page", fields(json!({ "title": "One" })))?;
            let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 1, "y": 2 })))?;
            tx.list_insert(&page, "shapes", 0, &shape)?;
            Ok(())
        })
        .unwrap();
    replica.snapshot().unwrap()
}

/// The child's half: builds the document into the file `OUT` names (nothing without it).
#[test]
fn child_builds_a_document() {
    if let Ok(path) = std::env::var(OUT) {
        std::fs::write(path, build()).unwrap();
    }
}

fn build_in_a_process(path: &PathBuf, epoch: Option<&str>) -> Vec<u8> {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "child_builds_a_document", "--test-threads=1", "--quiet"]).env(OUT, path).env_remove("SOURCE_DATE_EPOCH");
    if let Some(epoch) = epoch {
        command.env("SOURCE_DATE_EPOCH", epoch);
    }
    assert!(command.status().unwrap().success(), "the child build failed");
    std::fs::read(path).unwrap()
}

#[test]
fn the_same_steps_save_the_same_bytes_in_a_reproducible_build() {
    let dir = std::env::temp_dir().join(format!("kition-kdm-reproducible-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let first = build_in_a_process(&dir.join("0"), Some("1794182400"));
    for build in 1..3 {
        let again = build_in_a_process(&dir.join(build.to_string()), Some("1794182400"));
        assert!(first == again, "build {build} saved other bytes");
    }
    // Without the epoch, ids stay random: two builds differ.
    let a = build_in_a_process(&dir.join("random-a"), None);
    let b = build_in_a_process(&dir.join("random-b"), None);
    assert!(a != b, "random ids outside a reproducible build");
    std::fs::remove_dir_all(&dir).ok();
}
