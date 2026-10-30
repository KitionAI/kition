// Copied from kition-sdk crates/kition-kits/tests/sdk_kits.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The kits built on the Kition SDK, through the runtime's kit manager as the agent uses them:
//! open a real file, find commands, run one, save, and render a preview, each over the Kit
//! Protocol to the kit's own headless executable (`kit-<kit>`, from `kition-headless`).
//!
//! Each kit is tested when its executable is found: `KITION_KIT_<KIT>_BINARY`, or a debug build
//! in the sibling kit checkout (`../kition-<kit>/target/debug/kit-<kit>`). Otherwise it is skipped,
//! and so is a sibling build older than its fixture: the fixture changed with the kit Kition pins,
//! and a build from before may not read it.

use std::path::{Path, PathBuf};

use kition_kits::{Caller, KitDefinition, KitManager};
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

/// `KITION_KIT_<NAME>_BINARY` for `kit.<name>`.
fn variable(id: &str) -> String {
    let (prefix, suffix) = kition_kits::definitions::EXECUTABLE_VARIABLE;
    format!("{prefix}{}{suffix}", id.trim_start_matches("kit.").to_ascii_uppercase())
}

fn binary(id: &str, fixture: &Path) -> Executable {
    if let Some(path) = std::env::var_os(variable(id)).filter(|value| !value.is_empty()) {
        return Executable::Found(PathBuf::from(path));
    }
    let name = id.trim_start_matches("kit.");
    let sibling =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(format!("kition-{name}/target/debug/kit-{name}{}", std::env::consts::EXE_SUFFIX));
    if !sibling.is_file() {
        Executable::Missing
    } else if older(&sibling, fixture) {
        Executable::Stale(sibling)
    } else {
        Executable::Found(sibling)
    }
}

/// The kit an executable was built from: the manifest beside it (`definitions::manifest_beside`).
fn definition(executable: &Path, id: &str) -> &'static KitDefinition {
    let Some(manifest) = kition_kits::definitions::manifest_beside(executable) else { panic!("{}: no kit.json above it names it", executable.display()) };
    let kit = KitDefinition::from_manifest_text(&manifest).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(kit.id, id, "{} is {id}'s executable", executable.display());
    kition_kits::definitions::register([&kit]);
    kit
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
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(case.fixture);
        let executable = match binary(case.kit, &fixture) {
            Executable::Found(executable) => executable,
            Executable::Missing => {
                eprintln!(
                    "skipped {}: build it (cargo build -p kit-{} in its repository) or set {}",
                    case.kit,
                    case.kit.trim_start_matches("kit."),
                    variable(case.kit)
                );
                continue;
            }
            Executable::Stale(executable) => {
                eprintln!(
                    "skipped {}: {} is older than its fixture; rebuild it (cargo build -p kit-{}) or set {}",
                    case.kit,
                    executable.display(),
                    case.kit.trim_start_matches("kit."),
                    variable(case.kit)
                );
                continue;
            }
        };
        let kit = definition(&executable, case.kit);
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
        let original = std::fs::read(&fixture).unwrap_or_else(|err| panic!("{}: {err}", fixture.display()));
        std::fs::write(dir.path().join("work").join(case.fixture), &original).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
        let path = format!("work/{}", case.fixture);

        let opened = kits.open(Caller::Agent, &path).await.unwrap_or_else(|err| panic!("{}: open: {err}", kit.id));
        assert_eq!(opened.kit_id, kit.id);
        assert!(!opened.dirty);

        let found = kits
            .commands(Caller::Agent, kit.id, Some(&opened.document_id), Some(case.command))
            .await
            .unwrap_or_else(|err| panic!("{}: commands: {err}", kit.id));
        assert!(found.iter().any(|command| command.id == case.command), "{}: {} is listed", kit.id, case.command);
        let (file_command, file_params) = case.file_command;
        let listed = kits.commands(Caller::Agent, kit.id, Some(&opened.document_id), None).await.unwrap_or_else(|err| panic!("{err}"));
        assert!(!listed.iter().any(|command| command.id == file_command), "{}: {file_command} names a file and is not offered", kit.id);
        assert!(
            kits.execute(Caller::Agent, kit.id, &opened.document_id, file_command, object(file_params())).await.is_err(),
            "{}: {file_command} is refused",
            kit.id
        );

        let executed = kits
            .execute(Caller::Agent, kit.id, &opened.document_id, case.command, object((case.params)()))
            .await
            .unwrap_or_else(|err| panic!("{}: execute: {err}", kit.id));
        assert!(executed.changed && executed.document.dirty, "{}: the edit changed the document", kit.id);

        let saved = kits.save(Caller::Agent, kit.id, &opened.document_id).await.unwrap_or_else(|err| panic!("{}: save: {err}", kit.id));
        assert!(!saved.dirty);
        let written = std::fs::read(dir.path().join(&path)).unwrap_or_else(|err| panic!("{err}"));
        assert_ne!(written, original, "{}: the file on disk changed", kit.id);
        assert!(!dir.path().join("work").join(format!("elsewhere.{}", kit.extensions[0])).exists());

        let png = kits.preview(kit.id, &saved.document_id, 256).await.unwrap_or_else(|err| panic!("{}: preview: {err}", kit.id));
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
        let bytes: [u8; 4] = png.get(at..at + 4).and_then(|bytes| bytes.try_into().ok()).unwrap_or_default();
        u32::from_be_bytes(bytes)
    };
    (word(16), word(20))
}

/// The codes of a kit's check catalogue (`agent/checks.json`, KHP K17) in its package, when the
/// package is built (`scripts/build-kit-ui.sh <kit>`).
fn catalogue(kit: &str) -> Option<Vec<String>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/kits").join(format!("{kit}-ui/agent/checks.json"));
    let entries: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(entries.iter().filter_map(|entry| entry["code"].as_str().map(str::to_owned)).collect())
}

/// Fig is Agent-ready (KHP A38, A39, A41) through the agent's tools on its headless executable:
/// the check answers codes of its catalogue, inspect previews a diagnostic's target and a page
/// with the kit's own `file.render`, and export writes PNG, JPEG, SVG, and PDF files as new files
/// without changing or saving the design, however the kit reports the commands' view revision.
/// Cases: kition.agent.kit-export/fig-formats, kition.agent.kit-preview/fig-target.
#[tokio::test]
async fn the_agent_checks_previews_and_exports_a_fig_design() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Screen.kfig");
    let executable = match binary("kit.fig", &fixture) {
        Executable::Found(executable) => executable,
        Executable::Missing | Executable::Stale(_) => {
            eprintln!("skipped kit.fig: build kit-fig (cargo build -p kit-fig in kition-fig) or set {}", variable("kit.fig"));
            return;
        }
    };
    let kit = definition(&executable, "kit.fig");
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
    let original = std::fs::read(&fixture).unwrap_or_else(|err| panic!("{err}"));
    let file = dir.path().join("work/Screen.kfig");
    std::fs::write(&file, &original).unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
    let call = |name: &'static str, input: Value| {
        let kits = &kits;
        async move {
            kition_kits::tools::call(kits, name, &input)
                .await
                .unwrap_or_else(|| panic!("{name} is a kit tool"))
                .unwrap_or_else(|err| panic!("{name}: {}", err.message))
        }
    };
    let offered: Vec<String> = kition_kits::tools::installed(&kits).into_iter().map(|spec| spec.name).collect();
    assert!(offered.iter().any(|name| name == "fig_export"), "{offered:?}");

    // A layer off whole pixels: the check reports it with the layer as its target.
    call(
        "fig_run",
        json!({ "path": "work/Screen.kfig", "steps": [{ "command": "shape.rectangle", "params": { "x": 10.5, "y": 10.5, "width": 40, "height": 40 } }] }),
    )
    .await;
    let edited = std::fs::read(&file).unwrap_or_else(|err| panic!("{err}"));
    let checked = call("fig_check", json!({ "path": "work/Screen.kfig" })).await;
    let diagnostics = checked.output["diagnostics"].as_array().cloned().unwrap_or_default();
    let codes: Vec<&str> = diagnostics.iter().filter_map(|diagnostic| diagnostic["code"].as_str()).collect();
    assert!(codes.contains(&"fig.off-pixel"), "{codes:?}");
    match catalogue("fig") {
        Some(known) => assert!(codes.iter().all(|code| known.iter().any(|known| known == code)), "every code is in the catalogue: {codes:?}"),
        None => eprintln!("no fig package: the catalogue codes were not compared"),
    }
    let target = diagnostics.iter().find(|diagnostic| diagnostic["code"] == "fig.off-pixel").map(|diagnostic| diagnostic["target"].clone()).unwrap_or_default();
    assert!(target["path"].as_str().is_some_and(|path| path.starts_with("layer:")), "{target}");

    // The diagnostic's layer, drawn by the kit on whole pixels, then twice the size.
    let layer = call("fig_inspect", json!({ "path": "work/Screen.kfig", "target": target })).await;
    let [preview] = layer.previews.as_slice() else { panic!("one preview: {}", layer.previews.len()) };
    assert_eq!(png_size(&preview.png), (41, 41), "{}", preview.caption);
    assert!(preview.caption.contains("layer:"), "{}", preview.caption);
    let doubled = call("fig_inspect", json!({ "path": "work/Screen.kfig", "target": target, "scale": 2 })).await;
    assert_eq!(png_size(&doubled.previews[0].png), (82, 82));
    let page = call("fig_inspect", json!({ "path": "work/Screen.kfig", "target": { "page": 1 }, "maxSize": 64 })).await;
    let (width, height) = png_size(&page.previews[0].png);
    assert!(width.max(height) <= 64, "{width} x {height}");
    assert!(page.previews[0].caption.contains("part 1"));

    // Every format the kit exports, as a new file; the design is neither changed nor saved.
    let magic: [(&str, &[u8]); 4] = [("png", b"\x89PNG"), ("jpg", b"\xff\xd8\xff"), ("svg", b"<svg"), ("pdf", b"%PDF")];
    for (format, start) in magic {
        let to = format!("exports/Screen.{format}");
        let exported = call("fig_export", json!({ "path": "work/Screen.kfig", "to": to })).await;
        assert_eq!(exported.output["files"][0]["path"], to);
        assert_eq!(exported.output["files"][0]["created"], true);
        let bytes = std::fs::read(dir.path().join(&to)).unwrap_or_else(|err| panic!("{err}"));
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned();
        assert!(bytes.starts_with(start) || (format == "svg" && head.contains("<svg")), "{format}: {head:?}");
        assert_eq!(exported.output["bytes"], bytes.len());
    }
    let again = call("fig_export", json!({ "path": "work/Screen.kfig", "to": "exports/Screen.png", "options": { "scale": 2 } })).await;
    assert_eq!(again.output["files"][0]["path"], "exports/Screen 2.png", "an existing file is never replaced");
    let first = std::fs::read(dir.path().join("exports/Screen.png")).unwrap_or_default();
    let second = std::fs::read(dir.path().join("exports/Screen 2.png")).unwrap_or_default();
    assert_eq!(png_size(&second).0, png_size(&first).0 * 2, "options reach the kit");
    let refused = kition_kits::tools::call(&kits, "fig_export", &json!({ "path": "work/Screen.kfig", "to": "exports/Screen.gif" }))
        .await
        .and_then(Result::err)
        .map(|err| err.message)
        .unwrap_or_default();
    assert!(refused.contains("png, jpg, svg, or pdf"), "{refused}");
    let after = call("fig_inspect", json!({ "path": "work/Screen.kfig", "preview": false })).await;
    assert_eq!(after.output["dirty"], false, "renders and exports are not edits");
    assert_eq!(std::fs::read(&file).unwrap_or_default(), edited, "and the design on disk is as it was saved");
    kits.shutdown().await;
}

/// The names of a Fig design's layers, in tree order, as `fig_query` reads them from the object
/// model, with their object ids.
async fn fig_layers(kits: &KitManager, path: &str) -> Vec<(String, String)> {
    let read = kition_kits::tools::call(kits, "fig_query", &json!({ "path": path, "follow": "nodes", "fields": ["name"] }))
        .await
        .unwrap_or_else(|| panic!("fig_query is a kit tool"))
        .unwrap_or_else(|err| panic!("fig_query: {}", err.message));
    read.output["objects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|object| (object["id"].as_str().unwrap_or_default().to_owned(), object["fields"]["name"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// Fig on engine contract 2 serves its object model (schema `kit.fig`, namespace `Fig`) to the
/// agent through its headless executable: `fig_query` describes the schema and reads the layer
/// tree, `fig_batch` renames a layer and runs a command in one call and saves it (a failing op keeps
/// nothing of its batch), the agent's undo and redo take the command back and forward, and the
/// saved file carries its replica,
/// so the layers keep their object ids when the design is opened again.
/// Cases: kition.agent.kit-object-model/fig-headless.
#[tokio::test]
async fn the_agent_reads_and_edits_a_fig_design_through_its_object_model() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Screen.kfig");
    let executable = match binary("kit.fig", &fixture) {
        Executable::Found(executable) => executable,
        Executable::Missing | Executable::Stale(_) => {
            eprintln!("skipped kit.fig: build kit-fig (cargo build -p kit-fig in kition-fig) or set {}", variable("kit.fig"));
            return;
        }
    };
    let kit = definition(&executable, "kit.fig");
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
    let file = dir.path().join("work/Screen.kfig");
    std::fs::copy(&fixture, &file).unwrap_or_else(|err| panic!("{err}"));
    let path = "work/Screen.kfig";
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable.clone()))]);
    let call = |name: &'static str, input: Value| {
        let kits = &kits;
        async move { kition_kits::tools::call(kits, name, &input).await.unwrap_or_else(|| panic!("{name} is a kit tool")) }
    };

    // The schema: the root `Fig`, its layer tree of `Node` objects.
    let described = call("fig_query", json!({ "path": path, "describe": true })).await.unwrap_or_else(|err| panic!("fig_query: {}", err.message));
    assert_eq!(described.output["objects"][0]["id"], "fig");
    assert_eq!(described.output["objects"][0]["type"], "Fig");
    let types = described.output["types"].as_str().unwrap_or_default();
    assert!(types.contains("Fig (root)") && types.contains("nodes: tree of Node"), "{types}");
    assert_eq!(kits.described("kit.fig").map(|schema| schema["kit"].clone()), Some(json!("kit.fig")), "the kit's schema is kept for the tools' argument enums");
    let before = fig_layers(&kits, path).await;
    let names: Vec<&str> = before.iter().map(|(_, name)| name.as_str()).collect();
    assert_eq!(names, ["Page 1", "Frame 1", "Rectangle"]);
    let rectangle = before[2].0.clone();

    // One batch: rename the rectangle and draw another one with a command; saved.
    let batch = call(
        "fig_batch",
        json!({ "path": path, "ops": [
            { "op": "set", "target": rectangle, "field": "name", "value": "Hero card" },
            { "op": "command", "id": "shape.rectangle", "params": { "x": 600, "y": 120, "width": 200, "height": 120 } }
        ], "load": [{ "target": rectangle, "fields": ["name"] }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("fig_batch: {}", err.message));
    assert_eq!(batch.output["loaded"][0]["fields"]["name"], "Hero card", "{}", batch.output);
    let edited = fig_layers(&kits, path).await;
    assert_eq!(edited.len(), 4, "{edited:?}");
    assert!(edited.contains(&(rectangle.clone(), "Hero card".to_owned())));
    let saved = std::fs::read(&file).unwrap_or_else(|err| panic!("{err}"));
    assert!(saved.windows(13).any(|window| window == b"kdm/meta.json"), "the saved design carries its replica");

    // A failing op changes nothing and names itself.
    let refused = call(
        "fig_batch",
        json!({ "path": path, "ops": [
            { "op": "set", "target": rectangle, "field": "name", "value": "Never" },
            { "op": "set", "target": "no-such-object", "field": "name", "value": "x" }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("a batch with a missing target fails"));
    assert_eq!(refused.code.as_str(), "not-found", "{}", refused.message);
    assert_eq!(refused.index, Some(1), "the failing op is named");
    assert_eq!(fig_layers(&kits, path).await, edited, "nothing of the batch was kept");

    // The agent's undo takes back the batch's command, its own step; the rename stays, since the
    // headless object model hands model ops to the engine as a collaborator's changes (kition-sdk
    // `session::model::Exchange`), outside the undo history. Its redo brings the command back.
    call("fig_run", json!({ "path": path, "steps": [{ "command": "edit.undo" }], "save": false }))
        .await
        .unwrap_or_else(|err| panic!("fig_run edit.undo: {}", err.message));
    let undone = fig_layers(&kits, path).await;
    let names: Vec<&str> = undone.iter().map(|(_, name)| name.as_str()).collect();
    assert_eq!(names, ["Page 1", "Frame 1", "Hero card"], "undo takes the command back");
    assert_eq!(undone[2].0, rectangle);
    call("fig_run", json!({ "path": path, "steps": [{ "command": "edit.redo" }], "save": false }))
        .await
        .unwrap_or_else(|err| panic!("fig_run edit.redo: {}", err.message));
    assert_eq!(fig_layers(&kits, path).await, edited, "redo brings it back");
    kits.shutdown().await;

    // Opened again, the design is its saved replica: the same objects, the rename kept.
    let again = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
    assert_eq!(fig_layers(&again, path).await, edited);
    again.shutdown().await;
}

/// Fig schema `kit.fig` v2 keeps the libraries a design uses as `Library` objects in
/// `Fig.libraries` (kition-fig `docs/kdm.md`, V9). Through the headless executable the agent reads
/// them with `fig_query`, each with the library file's path as the design names it, and the
/// engine reads the linked file beside the design through its host's lent files (`library.list`),
/// never a copy. The fixtures were made with the Fig package's engine: `Design System.kfig` is a
/// design published as a library (one component, "Button/Primary"), and `App.kfig` links it
/// (`library.add` with `Design System.kfig`) and holds one instance of the button.
/// Cases: kition.kit-links.pick-link/fig-library-headless.
#[tokio::test]
async fn the_agent_reads_the_libraries_a_fig_design_links() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let executable = match binary("kit.fig", &fixtures.join("App.kfig")) {
        Executable::Found(executable) => executable,
        Executable::Missing | Executable::Stale(_) => {
            eprintln!("skipped kit.fig: build kit-fig (cargo build -p kit-fig in kition-fig) or set {}", variable("kit.fig"));
            return;
        }
    };
    let kit = definition(&executable, "kit.fig");
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
    for name in ["App.kfig", "Design System.kfig"] {
        std::fs::copy(fixtures.join(name), dir.path().join("work").join(name)).unwrap_or_else(|err| panic!("{err}"));
    }
    let path = "work/App.kfig";
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
    let call = |name: &'static str, input: Value| {
        let kits = &kits;
        async move { kition_kits::tools::call(kits, name, &input).await.unwrap_or_else(|| panic!("{name} is a kit tool")) }
    };

    let described = call("fig_query", json!({ "path": path, "describe": true })).await.unwrap_or_else(|err| panic!("fig_query: {}", err.message));
    let types = described.output["types"].as_str().unwrap_or_default();
    assert!(types.contains("libraries: list of Library"), "schema v2 lists the design's libraries: {types}");
    let read = call("fig_query", json!({ "path": path, "follow": "libraries", "fields": ["name", "path", "version"] }))
        .await
        .unwrap_or_else(|err| panic!("fig_query: {}", err.message));
    let libraries = read.output["objects"].as_array().cloned().unwrap_or_default();
    assert_eq!(libraries.len(), 1, "{}", read.output);
    assert_eq!(libraries[0]["type"], "Library", "{}", read.output);
    assert_eq!(libraries[0]["fields"]["name"], "Design System");
    assert_eq!(libraries[0]["fields"]["path"], "Design System.kfig");

    let listed = call("fig_run", json!({ "path": path, "steps": [{ "command": "library.list" }], "save": false }))
        .await
        .unwrap_or_else(|err| panic!("fig_run library.list: {}", err.message));
    let listed = &listed.output["completed"][0]["result"]["libraries"][0];
    assert_eq!(listed["path"], "Design System.kfig", "{listed}");
    assert_eq!(listed["version"], 1, "{listed}");
    assert!(listed.get("error").is_none(), "the linked file is read: {listed}");
    kits.shutdown().await;
    let library = std::fs::read(dir.path().join("work/Design System.kfig")).unwrap_or_else(|err| panic!("{err}"));
    let fixture = std::fs::read(fixtures.join("Design System.kfig")).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(library, fixture, "the library file is read, never written");

    // Without the file, the engine says it cannot read the library: it read the linked file.
    std::fs::remove_file(dir.path().join("work/Design System.kfig")).unwrap_or_else(|err| panic!("{err}"));
    let Some(executable) = (match binary("kit.fig", &fixtures.join("App.kfig")) {
        Executable::Found(executable) => Some(executable),
        Executable::Missing | Executable::Stale(_) => None,
    }) else {
        panic!("the executable is still there")
    };
    let again = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
    let missing = kition_kits::tools::call(&again, "fig_run", &json!({ "path": path, "steps": [{ "command": "library.list" }], "save": false }))
        .await
        .unwrap_or_else(|| panic!("fig_run is a kit tool"))
        .unwrap_or_else(|err| panic!("fig_run library.list: {}", err.message));
    let missing = &missing.output["completed"][0]["result"]["libraries"][0];
    assert!(missing["error"].as_str().is_some_and(|error| error.starts_with("Design System.kfig")), "{missing}");
    again.shutdown().await;
}
