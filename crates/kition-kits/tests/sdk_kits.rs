//! The kits built on the Kition SDK, through the runtime's kit manager as the agent uses them:
//! open a real file, find commands, run one, save, and render a preview, each over the Kit
//! Protocol to the kit's own headless executable (`kit-<kit>`, from `kition-headless`).
//!
//! Each kit is tested when its executable is found: `KITION_KIT_<KIT>_BINARY`, or a debug build
//! in the sibling kit checkout (`../kition-<kit>/target/debug/kit-<kit>`). Otherwise it is skipped.

use std::path::PathBuf;

use kition_kits::{Caller, KITS, KitManager};
use serde_json::{Map, Value, json};

struct Case {
    kit: &'static str,
    fixture: &'static str,
    command: &'static str,
    params: fn() -> Value,
    /// A command that names a file, which the agent must not be able to run.
    file_command: (&'static str, fn() -> Value),
}

const CASES: &[Case] = &[
    Case {
        kit: "kit.html",
        fixture: "Page.html",
        command: "html.setSource",
        params: || json!({ "source": "<!doctype html><body style=\"background:#5645d4\"><h1>Edited HTML</h1></body>" }),
        file_command: ("document.save", || json!({ "path": "elsewhere.html" })),
    },
    Case {
        kit: "kit.vector",
        fixture: "Drawing.kvector",
        command: "shape.ellipse",
        params: || json!({ "x": 100, "y": 20, "width": 60, "height": 60 }),
        file_command: ("document.save", || json!({ "path": "elsewhere.kvector" })),
    },
    Case {
        kit: "kit.effect",
        fixture: "Motion.keffect",
        command: "layer.newSolid",
        params: || json!({ "name": "Blue", "color": "#0000ff", "width": 32, "height": 36 }),
        file_command: ("file.saveAs", || json!({ "path": "elsewhere.keffect" })),
    },
    Case {
        kit: "kit.design",
        fixture: "Flyer.kdesign",
        command: "frame.create",
        params: || json!({ "rect": [300, 300, 400, 400], "content": "unassigned" }),
        file_command: ("file.saveACopy", || json!({ "path": "elsewhere.kdesign" })),
    },
    Case {
        kit: "kit.film",
        fixture: "Edit.kfilm",
        command: "file.newColorMatte",
        params: || json!({ "color": "#0000ff", "seconds": 1 }),
        file_command: ("file.saveAs", || json!({ "path": "elsewhere.kfilm" })),
    },
    Case {
        kit: "kit.cad",
        fixture: "Plan.dxf",
        command: "circle",
        params: || json!({ "center": [200, 150], "radius": 40 }),
        file_command: ("saveas", || json!({ "path": "elsewhere.dxf" })),
    },
    Case {
        kit: "kit.slide",
        fixture: "Slide.kslide",
        command: "shape.insert",
        params: || json!({ "preset": "ellipse", "rect": [100, 100, 200, 120] }),
        file_command: ("file.saveAs", || json!({ "path": "elsewhere.kslide" })),
    },
    Case {
        kit: "kit.doc",
        fixture: "Letter.docx",
        command: "text.insert",
        params: || json!({ "text": "Hello" }),
        file_command: ("file.saveAs", || json!({ "path": "elsewhere.docx" })),
    },
    Case {
        kit: "kit.sheet",
        fixture: "Budget.xlsx",
        command: "cell.set",
        params: || json!({ "cell": "C2", "input": "99" }),
        file_command: ("file.saveAs", || json!({ "path": "elsewhere.xlsx" })),
    },
    Case {
        kit: "kit.pdf",
        fixture: "Report.pdf",
        command: "page_rotate",
        params: || json!({ "degrees": 90, "pages": [1] }),
        file_command: ("doc_save", || json!({ "path": "elsewhere.pdf" })),
    },
    Case {
        kit: "kit.table",
        fixture: "Tasks.ktable",
        command: "table.records.create",
        params: || json!({ "tableId": 1, "values": { "title": "Review the plan" } }),
        file_command: ("document.save", || json!({ "path": "elsewhere.ktable" })),
    },
    Case {
        kit: "kit.board",
        fixture: "Plan.kboard",
        command: "element.create",
        params: || json!({ "elements": [{ "kind": "shape", "position": { "x": 300, "y": 200 }, "size": { "w": 240, "h": 120 } }] }),
        file_command: ("document.save", || json!({ "path": "elsewhere.kboard" })),
    },
    Case {
        kit: "kit.note",
        fixture: "Notes.md",
        command: "text.insert",
        params: || json!({ "at": 0, "text": "# Agenda\n\n" }),
        file_command: ("document.save", || json!({ "path": "elsewhere.md" })),
    },
    Case {
        kit: "kit.cube",
        fixture: "Room.kcube",
        command: "add.uvSphere",
        params: || json!({ "location": [2, 0, 1], "radius": 0.5 }),
        file_command: ("document.save", || json!({ "path": "elsewhere.kcube" })),
    },
    Case {
        kit: "kit.fig",
        fixture: "Screen.kfig",
        command: "shape.rectangle",
        params: || json!({ "x": 0, "y": 0, "width": 40, "height": 40 }),
        file_command: ("document.save", || json!({ "path": "elsewhere.kfig" })),
    },
];

fn binary(kit: &kition_kits::KitDefinition) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(kit.binary_env).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let name = kit.id.trim_start_matches("kit.");
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(format!(
            "kition-{name}/target/debug/kit-{name}{}",
            std::env::consts::EXE_SUFFIX
        ));
    sibling.is_file().then_some(sibling)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[tokio::test]
async fn the_agent_edits_files_of_every_sdk_kit_through_its_headless_executable() {
    let mut tested = Vec::new();
    for case in CASES {
        let Some(kit) = KITS.iter().find(|kit| kit.id == case.kit) else {
            panic!("{} is not a kit", case.kit)
        };
        let Some(executable) = binary(kit) else {
            eprintln!(
                "skipped {}: build it (cargo build -p kit-{} in its repository) or set {}",
                kit.id,
                kit.id.trim_start_matches("kit."),
                kit.binary_env
            );
            continue;
        };
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(case.fixture);
        let original =
            std::fs::read(&fixture).unwrap_or_else(|err| panic!("{}: {err}", fixture.display()));
        std::fs::write(dir.path().join("work").join(case.fixture), &original)
            .unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable))],
        );
        let path = format!("work/{}", case.fixture);

        let opened = kits
            .open(Caller::Agent, &path)
            .await
            .unwrap_or_else(|err| panic!("{}: open: {err}", kit.id));
        assert_eq!(opened.kit_id, kit.id);
        assert!(!opened.dirty);

        let found = kits
            .commands(
                Caller::Agent,
                kit.id,
                Some(&opened.document_id),
                Some(case.command),
            )
            .await
            .unwrap_or_else(|err| panic!("{}: commands: {err}", kit.id));
        assert!(
            found.iter().any(|command| command.id == case.command),
            "{}: {} is listed",
            kit.id,
            case.command
        );
        let (file_command, file_params) = case.file_command;
        let listed = kits
            .commands(Caller::Agent, kit.id, Some(&opened.document_id), None)
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(
            !listed.iter().any(|command| command.id == file_command),
            "{}: {file_command} names a file and is not offered",
            kit.id
        );
        assert!(
            kits.execute(
                Caller::Agent,
                kit.id,
                &opened.document_id,
                file_command,
                object(file_params())
            )
            .await
            .is_err(),
            "{}: {file_command} is refused",
            kit.id
        );

        let executed = kits
            .execute(
                Caller::Agent,
                kit.id,
                &opened.document_id,
                case.command,
                object((case.params)()),
            )
            .await
            .unwrap_or_else(|err| panic!("{}: execute: {err}", kit.id));
        assert!(
            executed.changed && executed.document.dirty,
            "{}: the edit changed the document",
            kit.id
        );

        let saved = kits
            .save(Caller::Agent, kit.id, &opened.document_id)
            .await
            .unwrap_or_else(|err| panic!("{}: save: {err}", kit.id));
        assert!(!saved.dirty);
        let written = std::fs::read(dir.path().join(&path)).unwrap_or_else(|err| panic!("{err}"));
        assert_ne!(written, original, "{}: the file on disk changed", kit.id);
        assert!(
            !dir.path()
                .join("work")
                .join(format!("elsewhere.{}", kit.extensions[0]))
                .exists()
        );

        let png = kits
            .preview(kit.id, &saved.document_id, 256)
            .await
            .unwrap_or_else(|err| panic!("{}: preview: {err}", kit.id));
        assert_eq!(&png[1..4], b"PNG", "{}", kit.id);
        kits.shutdown().await;
        tested.push(kit.id);
    }
    eprintln!("tested: {tested:?}");
}
