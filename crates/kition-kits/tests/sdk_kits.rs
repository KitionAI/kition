//! The kits built on the Kition SDK, through the runtime's kit manager as the agent uses them:
//! open a real file, find commands, run one, save, and render a preview, each over the Kit
//! Protocol to the kit's own headless executable (`kit-<kit>`, from `kition-headless`).
//!
//! Each kit is tested when its executable is found: `KITION_KIT_<KIT>_BINARY`, or a debug build
//! in the sibling kit checkout (`../kition-<kit>/target/debug/kit-<kit>`). Otherwise it is skipped,
//! and so is a sibling build older than its fixture: the fixture changed with the kit Kition pins,
//! and a build from before may not read it.

use std::path::{Path, PathBuf};

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

/// A kit's executable to test, or why there is none.
enum Executable {
    Found(PathBuf),
    Missing,
    /// A sibling debug build made before its fixture last changed.
    Stale(PathBuf),
}

fn binary(kit: &kition_kits::KitDefinition, fixture: &Path) -> Executable {
    if let Some(path) = std::env::var_os(kit.binary_env).filter(|value| !value.is_empty()) {
        return Executable::Found(PathBuf::from(path));
    }
    let name = kit.id.trim_start_matches("kit.");
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(format!(
            "kition-{name}/target/debug/kit-{name}{}",
            std::env::consts::EXE_SUFFIX
        ));
    if !sibling.is_file() {
        Executable::Missing
    } else if older(&sibling, fixture) {
        Executable::Stale(sibling)
    } else {
        Executable::Found(sibling)
    }
}

/// Whether `executable` was built before `fixture` last changed in this checkout.
fn older(executable: &Path, fixture: &Path) -> bool {
    let modified = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified());
    matches!((modified(executable), modified(fixture)), (Ok(built), Ok(changed)) if built < changed)
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
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(case.fixture);
        let executable = match binary(kit, &fixture) {
            Executable::Found(executable) => executable,
            Executable::Missing => {
                eprintln!(
                    "skipped {}: build it (cargo build -p kit-{} in its repository) or set {}",
                    kit.id,
                    kit.id.trim_start_matches("kit."),
                    kit.binary_env
                );
                continue;
            }
            Executable::Stale(executable) => {
                eprintln!(
                    "skipped {}: {} is older than its fixture; rebuild it (cargo build -p kit-{}) or set {}",
                    kit.id,
                    executable.display(),
                    kit.id.trim_start_matches("kit."),
                    kit.binary_env
                );
                continue;
            }
        };
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
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

/// A PNG's width and height, from its header.
fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(png.get(1..4), Some(&b"PNG"[..]), "a PNG");
    let word = |at: usize| {
        let bytes: [u8; 4] = png
            .get(at..at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_default();
        u32::from_be_bytes(bytes)
    };
    (word(16), word(20))
}

/// The codes of a kit's check catalogue (`agent/checks.json`, KHP K17) in its package, when the
/// package is built (`scripts/build-kit-ui.sh <kit>`).
fn catalogue(kit: &str) -> Option<Vec<String>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/kits")
        .join(format!("{kit}-ui/agent/checks.json"));
    let entries: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(
        entries
            .iter()
            .filter_map(|entry| entry["code"].as_str().map(str::to_owned))
            .collect(),
    )
}

/// Fig is Agent-ready (KHP A38, A39, A41) through the agent's tools on its headless executable:
/// the check answers codes of its catalogue, inspect previews a diagnostic's target and a page
/// with the kit's own `file.render`, and export writes PNG, JPEG, SVG, and PDF files as new files
/// without changing or saving the design, however the kit reports the commands' view revision.
/// Cases: kition.agent.kit-export/fig-formats, kition.agent.kit-preview/fig-target.
#[tokio::test]
async fn the_agent_checks_previews_and_exports_a_fig_design() {
    let Some(kit) = KITS.iter().find(|kit| kit.id == "kit.fig") else {
        panic!("kit.fig is a kit")
    };
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Screen.kfig");
    let executable = match binary(kit, &fixture) {
        Executable::Found(executable) => executable,
        Executable::Missing | Executable::Stale(_) => {
            eprintln!(
                "skipped kit.fig: build kit-fig (cargo build -p kit-fig in kition-fig) or set {}",
                kit.binary_env
            );
            return;
        }
    };
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
    let original = std::fs::read(&fixture).unwrap_or_else(|err| panic!("{err}"));
    let file = dir.path().join("work/Screen.kfig");
    std::fs::write(&file, &original).unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(
        Some(dir.path().to_path_buf()),
        vec![(kit, Some(executable))],
    );
    let call = |name: &'static str, input: Value| {
        let kits = &kits;
        async move {
            kition_kits::tools::call(kits, name, &input)
                .await
                .unwrap_or_else(|| panic!("{name} is a kit tool"))
                .unwrap_or_else(|err| panic!("{name}: {}", err.message))
        }
    };
    let offered: Vec<String> = kition_kits::tools::installed(&kits)
        .into_iter()
        .map(|spec| spec.name)
        .collect();
    assert!(
        offered.iter().any(|name| name == "fig_export"),
        "{offered:?}"
    );

    // A layer off whole pixels: the check reports it with the layer as its target.
    call(
        "fig_run",
        json!({ "path": "work/Screen.kfig", "steps": [{ "command": "shape.rectangle", "params": { "x": 10.5, "y": 10.5, "width": 40, "height": 40 } }] }),
    )
    .await;
    let edited = std::fs::read(&file).unwrap_or_else(|err| panic!("{err}"));
    let checked = call("fig_check", json!({ "path": "work/Screen.kfig" })).await;
    let diagnostics = checked.output["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let codes: Vec<&str> = diagnostics
        .iter()
        .filter_map(|diagnostic| diagnostic["code"].as_str())
        .collect();
    assert!(codes.contains(&"fig.off-pixel"), "{codes:?}");
    match catalogue("fig") {
        Some(known) => assert!(
            codes
                .iter()
                .all(|code| known.iter().any(|known| known == code)),
            "every code is in the catalogue: {codes:?}"
        ),
        None => eprintln!("no fig package: the catalogue codes were not compared"),
    }
    let target = diagnostics
        .iter()
        .find(|diagnostic| diagnostic["code"] == "fig.off-pixel")
        .map(|diagnostic| diagnostic["target"].clone())
        .unwrap_or_default();
    assert!(
        target["path"]
            .as_str()
            .is_some_and(|path| path.starts_with("layer:")),
        "{target}"
    );

    // The diagnostic's layer, drawn by the kit on whole pixels, then twice the size.
    let layer = call(
        "fig_inspect",
        json!({ "path": "work/Screen.kfig", "target": target }),
    )
    .await;
    let [preview] = layer.previews.as_slice() else {
        panic!("one preview: {}", layer.previews.len())
    };
    assert_eq!(png_size(&preview.png), (41, 41), "{}", preview.caption);
    assert!(preview.caption.contains("layer:"), "{}", preview.caption);
    let doubled = call(
        "fig_inspect",
        json!({ "path": "work/Screen.kfig", "target": target, "scale": 2 }),
    )
    .await;
    assert_eq!(png_size(&doubled.previews[0].png), (82, 82));
    let page = call(
        "fig_inspect",
        json!({ "path": "work/Screen.kfig", "target": { "page": 1 }, "maxSize": 64 }),
    )
    .await;
    let (width, height) = png_size(&page.previews[0].png);
    assert!(width.max(height) <= 64, "{width} x {height}");
    assert!(page.previews[0].caption.contains("part 1"));

    // Every format the kit exports, as a new file; the design is neither changed nor saved.
    let magic: [(&str, &[u8]); 4] = [
        ("png", b"\x89PNG"),
        ("jpg", b"\xff\xd8\xff"),
        ("svg", b"<svg"),
        ("pdf", b"%PDF"),
    ];
    for (format, start) in magic {
        let to = format!("exports/Screen.{format}");
        let exported = call(
            "fig_export",
            json!({ "path": "work/Screen.kfig", "to": to }),
        )
        .await;
        assert_eq!(exported.output["files"][0]["path"], to);
        assert_eq!(exported.output["files"][0]["created"], true);
        let bytes = std::fs::read(dir.path().join(&to)).unwrap_or_else(|err| panic!("{err}"));
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned();
        assert!(
            bytes.starts_with(start) || (format == "svg" && head.contains("<svg")),
            "{format}: {head:?}"
        );
        assert_eq!(exported.output["bytes"], bytes.len());
    }
    let again = call(
        "fig_export",
        json!({ "path": "work/Screen.kfig", "to": "exports/Screen.png", "options": { "scale": 2 } }),
    )
    .await;
    assert_eq!(
        again.output["files"][0]["path"], "exports/Screen 2.png",
        "an existing file is never replaced"
    );
    let first = std::fs::read(dir.path().join("exports/Screen.png")).unwrap_or_default();
    let second = std::fs::read(dir.path().join("exports/Screen 2.png")).unwrap_or_default();
    assert_eq!(
        png_size(&second).0,
        png_size(&first).0 * 2,
        "options reach the kit"
    );
    let refused = kition_kits::tools::call(
        &kits,
        "fig_export",
        &json!({ "path": "work/Screen.kfig", "to": "exports/Screen.gif" }),
    )
    .await
    .and_then(Result::err)
    .map(|err| err.message)
    .unwrap_or_default();
    assert!(refused.contains("png, jpg, svg, or pdf"), "{refused}");
    let after = call(
        "fig_inspect",
        json!({ "path": "work/Screen.kfig", "preview": false }),
    )
    .await;
    assert_eq!(
        after.output["dirty"], false,
        "renders and exports are not edits"
    );
    assert_eq!(
        std::fs::read(&file).unwrap_or_default(),
        edited,
        "and the design on disk is as it was saved"
    );
    kits.shutdown().await;
}
