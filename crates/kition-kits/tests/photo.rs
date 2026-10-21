//! The runtime against a real `kit-photo` build. Runs only when both are set:
//!
//! ```sh
//! KITION_KIT_PHOTO_BINARY=<kit-photo>/target/debug/kit-photo \
//! KITION_KIT_PHOTO_FIXTURE=<a layered .psd> cargo test -p kition-kits --test photo
//! ```

use std::path::PathBuf;

use kition_kits::{Caller, KITS, KitManager};
use serde_json::{Map, json};

fn configured() -> Option<(PathBuf, PathBuf)> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    match (
        var("KITION_KIT_PHOTO_BINARY"),
        var("KITION_KIT_PHOTO_FIXTURE"),
    ) {
        (Some(binary), Some(fixture)) => Some((binary, fixture)),
        _ => {
            eprintln!("skipped: set KITION_KIT_PHOTO_BINARY and KITION_KIT_PHOTO_FIXTURE");
            None
        }
    }
}

#[tokio::test]
async fn edits_a_real_psd_through_kit_photo() {
    let Some((binary, fixture)) = configured() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    let target = dir.path().join("art/poster.psd");
    std::fs::copy(&fixture, &target).unwrap_or_else(|err| panic!("{err}"));
    let original = std::fs::read(&target).unwrap_or_else(|err| panic!("{err}"));
    let photo = KITS
        .iter()
        .find(|kit| kit.id == "kit.photo")
        .unwrap_or_else(|| panic!("kit.photo"));
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(photo, Some(binary))]);

    let opened = kits
        .open(Caller::User, "art/poster.psd")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(opened.path.as_deref(), Some("art/poster.psd"));
    let layers =
        |view: &kition_kits::DocumentView| view.details["layers"].as_array().map_or(0, Vec::len);
    let before = layers(&opened);
    println!("opened: {} ({before} layers)", opened.summary);

    let png = kits
        .preview("kit.photo", &opened.document_id, 256)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(png.get(..8), Some(&b"\x89PNG\r\n\x1a\n"[..]));

    // The agent finds a command and runs it over its own connection.
    let found = kits
        .commands(
            Caller::Agent,
            "kit.photo",
            Some(&opened.document_id),
            Some("new layer"),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(
        found.iter().any(|command| command.id == "layer.new.layer"),
        "{found:?}"
    );
    let agent_view = kits
        .open(Caller::Agent, "art/poster.psd")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(agent_view.document_id, opened.document_id);
    let executed = kits
        .execute(
            Caller::Agent,
            "kit.photo",
            &opened.document_id,
            "layer.new.layer",
            Map::from_iter([("name".into(), json!("Agent layer"))]),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(executed.changed && executed.document.dirty);
    assert_eq!(layers(&executed.document), before + 1);

    // A person undoes it from the tab, redoes it, and saves.
    let undone = kits
        .execute(
            Caller::User,
            "kit.photo",
            &opened.document_id,
            "edit.undo",
            Map::new(),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(layers(&undone.document), before);
    kits.execute(
        Caller::User,
        "kit.photo",
        &opened.document_id,
        "edit.redo",
        Map::new(),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    let saved = kits
        .save(Caller::User, "kit.photo", &opened.document_id)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(!saved.dirty);
    assert_ne!(
        std::fs::read(&target).unwrap_or_else(|err| panic!("{err}")),
        original
    );

    // A fresh kit sees the saved layer.
    kits.shutdown().await;
    let reopened = kits
        .open(Caller::User, "art/poster.psd")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(layers(&reopened), before + 1, "{:?}", reopened.details);
    println!("after save: {}", reopened.summary);

    // A new image from the create menu.
    let created = kits
        .create(
            Caller::User,
            "art",
            "psd",
            Map::from_iter([
                ("width".into(), json!(320)),
                ("height".into(), json!(200)),
                ("background".into(), json!("white")),
            ]),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(created.path.as_deref(), Some("art/Untitled Photo.psd"));
    assert_eq!(created.details["width"], 320);
    assert!(dir.path().join("art/Untitled Photo.psd").is_file());
    kits.shutdown().await;
}
