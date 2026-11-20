// Copied from kition-sdk crates/kition-kit-mock/src/kit.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Mock kit state and method handlers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use kition_kdm::batch::{self, BatchError, BatchErrorCode, BatchTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx, Version};

use kition_kit_process_protocol::framing::{self, write_frame_async};

use crate::deck;
use crate::space::{self, SPACE};
use crate::tracks::{self, TRACKS};
use kition_kit_process_protocol::launch::{REQUEST_TIMEOUT, Surface};
use kition_kit_process_protocol::methods::{self, HostServiceMethod, NotificationMethod, RequestMethod};
use kition_kit_process_protocol::transport::BoxWriter;
use kition_kit_process_protocol::types::*;
use kition_kit_process_protocol::{ErrorData, ErrorReason, Message, Notification, PROTOCOL_VERSION, Request, RequestId, Response, RpcError, base64};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

pub type Writer = Arc<tokio::sync::Mutex<BoxWriter>>;

const FORMAT: &str = "mock.text";

/// The kit id, file extension and new-document format this mock answers to: `kit.mock`,
/// `mocktext` and `mock.text`, or what `KITION_KIT_MOCK_AS=<kit id>:<extension>[:<format>]` names,
/// so a test can stand it in for one of the kits a host knows (the host checks the id a kit
/// reports, and creates documents in the format its manifest declares).
static IDENTITY: LazyLock<(String, String, String)> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_AS")
        .ok()
        .and_then(|value| {
            let mut parts = value.split(':').map(str::trim);
            let (id, extension) = (parts.next()?, parts.next()?);
            Some((id.to_owned(), extension.to_owned(), parts.next().unwrap_or(FORMAT).to_owned()))
        })
        .filter(|(id, extension, format)| !id.is_empty() && !extension.is_empty() && !format.is_empty())
        .unwrap_or_else(|| ("kit.mock".to_owned(), "mocktext".to_owned(), FORMAT.to_owned()))
});

/// The kit version `kit.initialize` reports: its manifest's (`kit.json` `version`), or what
/// `KITION_KIT_MOCK_VERSION` names, so a test that stands it in for another kit reports that
/// kit's manifest version, and one that gives another version tests a stale executable (a host
/// refuses an executable whose version is not its manifest's, host rule H11).
static VERSION: LazyLock<String> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_VERSION").ok().filter(|version| !version.trim().is_empty()).unwrap_or_else(|| {
        serde_json::from_str::<Value>(include_str!("../kit.json"))
            .ok()
            .and_then(|manifest| manifest.get("version").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default()
    })
});

/// The object model a document answers `model.describe` and `model.batch` with: the note's text
/// and a list of tags.
const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Note",
  "types": {
    "Note": { "fields": { "text": { "kind": "text" }, "tags": { "kind": "list", "of": "Tag" } } },
    "Tag": { "fields": { "name": { "kind": "string" } } }
  }
}"#;
/// [`SCHEMA`] with a field of each kind a writer must tell apart, for `KITION_KIT_MOCK_SCHEMA=every-kind`:
/// an enum, a read-only field (OM8), a reference, and a read-only type.
const SCHEMA_EVERY_KIND: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Note",
  "types": {
    "Note": { "fields": { "text": { "kind": "text" }, "tags": { "kind": "list", "of": "Tag" } } },
    "Tag": { "fields": {
      "name": { "kind": "string" },
      "color": { "kind": "enum", "values": ["red", "green"], "optional": true },
      "handle": { "kind": "string", "optional": true, "readOnly": true },
      "parent": { "kind": "ref", "of": "Tag", "optional": true }
    } },
    "Kept": { "fields": { "xml": { "kind": "string" } }, "readOnly": true }
  }
}"#;

/// [`SCHEMA`] with types whose objects the kit numbers and names by those numbers (tool ids,
/// KitObjectModel OM9), for `KITION_KIT_MOCK_SCHEMA=tool-ids`: frames (`frame:1`), their cells,
/// numbered per frame (`frame:1/cell:2`), and pins and flags, numbered apart under one empty
/// prefix, so their ids collide. Tags keep object ids.
const SCHEMA_TOOL_IDS: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Note",
  "types": {
    "Note": { "fields": {
      "text": { "kind": "text" },
      "tags": { "kind": "list", "of": "Tag" },
      "frames": { "kind": "list", "of": "Frame" },
      "pins": { "kind": "list", "of": "Pin" },
      "flags": { "kind": "list", "of": "Flag" }
    } },
    "Tag": { "fields": { "name": { "kind": "string" }, "frame": { "kind": "ref", "of": "Frame", "optional": true } } },
    "Frame": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "name": { "kind": "string", "optional": true },
      "link": { "kind": "ref", "of": "Frame", "optional": true },
      "cells": { "kind": "list", "of": "Cell" }
    }, "toolId": { "field": "number", "prefix": "frame:" } },
    "Cell": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "label": { "kind": "string", "optional": true }
    }, "toolId": { "field": "number", "prefix": "cell:", "parent": "Frame" } },
    "Pin": { "fields": { "number": { "kind": "integer", "optional": true, "readOnly": true } }, "toolId": { "field": "number" } },
    "Flag": { "fields": { "number": { "kind": "integer", "optional": true, "readOnly": true } }, "toolId": { "field": "number" } }
  }
}"#;

/// Whether documents have an object model: not when `KITION_KIT_MOCK_SCHEMA=none`, which stands
/// in for a kit without one (every `model.*` request is not found).
static MODEL: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_SCHEMA").map_or(true, |value| value.trim() != "none"));

/// Opt-in replica transport for draft review tests. `export` deliberately refuses `model.open`
/// so the host keeps a file draft; `full` also opens snapshots. The default still exercises a
/// kit without replica transport.
static REPLICA: LazyLock<String> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_REPLICA").unwrap_or_default());

/// `KITION_KIT_MOCK_FILE_REPLICA=1`: the file keeps the document's replica (as the board, table,
/// layout, design and scene kits do): the text, [`REPLICA_MARK`], then the replica's snapshot in
/// base64. A document opens from it, keeping its docId and object ids, and a save writes it again.
/// The kit then serves `document.identity` and `document.fork` (feature `document.identity`) and
/// `model.export` and `model.import`; without it, it declares neither and answers both "method not
/// found", as a kit that has not declared the feature does.
static FILE_REPLICA: LazyLock<bool> = LazyLock::new(|| std::env::var_os("KITION_KIT_MOCK_FILE_REPLICA").is_some_and(|value| value == "1"));

/// Where a [`FILE_REPLICA`] file's replica starts.
const REPLICA_MARK: &str = "\n%%kition-mock-replica%%\n";

/// A file's text and the replica it embeds, when [`FILE_REPLICA`] and it has one.
fn split_file(text: String) -> Result<(String, Option<Replica>), RpcError> {
    if !*FILE_REPLICA {
        return Ok((text, None));
    }
    let Some((body, replica)) = text.split_once(REPLICA_MARK) else { return Ok((text, None)) };
    let damaged = |detail: String| RpcError::kit_detail(ErrorReason::UnsupportedFormat, format!("the file's replica is damaged: {detail}"));
    let bytes = base64::decode(replica.trim()).ok_or_else(|| damaged("not base64".to_owned()))?;
    let schema = Arc::new(Schema::parse(schema_text()).map_err(|error| RpcError::internal(error.to_string()))?);
    let replica = Replica::load(schema, &bytes, ActorId::random()).map_err(|error| damaged(error.to_string()))?;
    Ok((body.to_owned(), Some(replica)))
}

/// The file of `text` with `replica` embedded, or the text alone.
fn joined_file(text: &str, replica: Option<&Replica>) -> Result<String, RpcError> {
    match replica {
        None => Ok(text.to_owned()),
        Some(replica) => {
            let snapshot = replica.snapshot().map_err(|error| RpcError::internal(error.to_string()))?;
            Ok(format!("{text}{REPLICA_MARK}{}", base64::encode(&snapshot)))
        }
    }
}

/// The diagnostic `document.check` answers while the text holds [`TODO`]: a warning about the
/// whole document, which goes once the text no longer holds it.
const TODO: &str = "TODO";
const TODO_CODE: &str = "mock.todo";

/// The schema documents answer with: [`SCHEMA`], [`SCHEMA_EVERY_KIND`] when
/// `KITION_KIT_MOCK_SCHEMA=every-kind`, or [`SCHEMA_TOOL_IDS`] when it is `tool-ids`.
fn schema_text() -> &'static str {
    if *DECK {
        return deck::schema();
    }
    if *TRACKS {
        return tracks::schema();
    }
    match std::env::var("KITION_KIT_MOCK_SCHEMA").as_deref().map(str::trim) {
        Ok("every-kind") => SCHEMA_EVERY_KIND,
        Ok("tool-ids") => SCHEMA_TOOL_IDS,
        _ => SCHEMA,
    }
}

/// Whether a batch runs the kit's commands (`text.append`, `text.clear`) as a real kit does
/// (`KITION_KIT_MOCK_BATCH=commands`); otherwise a `command` operation fails the batch.
static BATCH_COMMANDS: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_BATCH").is_ok_and(|value| value.trim() == "commands"));

/// Whether documents have slides (`KITION_KIT_MOCK_PARTS=slides`): each line of the text is a
/// slide and each `|`-separated piece of it an object, whose id (`s1`, `s2`, …) is unique only
/// within its slide, as in an engine that resolves ids against the current slide. The kit then
/// offers `slide.go`, `slide.inspect`, `shape.text` and `shape.upper`, which edit objects of the
/// current slide, `selection.set`, and `format.mark`, which marks the selected objects (`*b1*`)
/// and takes no id at all. The current slide and the selection are editor state, not the
/// document: the kit answers the Kit Process Protocol's `context.get`, `context.set` and
/// `context.restore` for them, unless [`CONTEXT`] says it has no such hooks.
static SLIDES: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| value.trim() == "slides"));

/// Whether documents have a timeline (`KITION_KIT_MOCK_PARTS=timeline`): each line of the text is
/// a sequence of [`SEQUENCE_SECONDS`] at [`FPS`] frames a second, counted from 1. The kit then
/// offers `playhead.set` and `sequence.open`, which move the editor's playhead and open sequence
/// (editor state, answered by `context.*`), and its render command [`RENDER`], which draws an
/// explicit view (`target.time`, `target.range` with `target.frames`, `target.sequence`) and never
/// reads the playhead or the open sequence.
/// Whether documents are decks (`KITION_KIT_MOCK_PARTS=deck`, [`deck`]): slides and shapes in an
/// object model whose ids survive edits and reloads. The kit then offers `slide.go`,
/// `slide.inspect`, the deck's editing commands, and `edit.undo` on the object model, and answers
/// `context.*` for the current slide and the selection.
static DECK: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| value.trim() == "deck"));

static TIMELINE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| value.trim() == "timeline"));

/// The noun a timeline's `context.set` takes its part by (`KITION_KIT_MOCK_PART_NOUN`): `sequence`
/// by default, counted from 1; any other noun (`page`, a kit declaring a built-in noun as its own)
/// names a sequence by the kit's own id, counted from 0.
static PART_NOUN: LazyLock<String> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_PART_NOUN").ok().map(|noun| noun.trim().to_owned()).filter(|noun| !noun.is_empty()).unwrap_or_else(|| "sequence".to_owned())
});

/// The render command of documents with a timeline ([`TIMELINE`]), the kit's `agent.render`.
const RENDER: &str = "file.render";
/// The length of every sequence, in seconds.
const SEQUENCE_SECONDS: f64 = 10.0;
/// Frames a second.
const FPS: f64 = 10.0;
/// The size of one frame at scale 1.
const FRAME: (u32, u32) = (16, 9);

/// Whether the kit writes some of its editor state into its file, as the video kit writes its
/// open sequence and the 3D kit its viewport (`KITION_KIT_MOCK_STATE_IN_FILE=1`): with slides
/// ([`SLIDES`]), a saved file ends with a line [`EDITOR_LINE`] naming the current slide (counted
/// from 1), and opening a file with that line makes that slide current.
static STATE_IN_FILE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_STATE_IN_FILE").is_ok_and(|value| value.trim() == "1"));

/// The start of the line that names the current slide in a file ([`STATE_IN_FILE`]).
const EDITOR_LINE: &str = "\n#editor slide=";

/// A file's text and the current slide (counted from 0) its editor line names ([`STATE_IN_FILE`]).
fn editor_line(text: String) -> (String, usize) {
    if !*STATE_IN_FILE {
        return (text, 0);
    }
    match text.rsplit_once(EDITOR_LINE).and_then(|(body, slide)| Some((body, slide.trim().parse::<usize>().ok()?.checked_sub(1)?))) {
        Some((body, current)) => (body.to_owned(), current),
        None => (text, 0),
    }
}

/// What a save writes: the text, and with [`STATE_IN_FILE`] the current slide's line.
fn file_text(text: &str, current: usize) -> String {
    if *STATE_IN_FILE { format!("{text}{EDITOR_LINE}{}", current + 1) } else { text.to_owned() }
}

/// Whether the kit reads a file that changed on disk late (`KITION_KIT_MOCK_REREAD=late`):
/// `document.didChangeOnDisk` reads it again only after a `model.version` of the document was
/// answered, before the next request is handled, on whichever connection. A real kit handles the
/// host's notification on the host's connection while it answers the agent's requests on the
/// agent's, so the version a server reads first may be the one before the read and what it reads
/// next the one after; this makes that order certain.
static REREAD_LATE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_REREAD").is_ok_and(|value| value.trim() == "late"));

/// Whether the kit answers `context.*` (`KITION_KIT_MOCK_CONTEXT=none` stands in for a kit
/// without the editor-state hooks: the requests are not found, and its commands still declare
/// what they read).
static CONTEXT: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_CONTEXT").map_or(true, |value| value.trim() != "none"));

/// The stable id of the slide at `index` (counted from 0), as `slide.inspect` lists it and
/// `slide.go` takes it.
fn slide_id(index: usize) -> u64 {
    101 + index as u64
}

/// The slides of `text` (see [`SLIDES`]): each slide's objects' texts.
fn slides_of(text: &str) -> Vec<Vec<String>> {
    text.split('\n').map(|line| line.split('|').map(str::to_owned).collect()).collect()
}

/// [`slides_of`] written back as text.
fn slides_text(slides: &[Vec<String>]) -> String {
    slides.iter().map(|objects| objects.join("|")).collect::<Vec<_>>().join("\n")
}

/// The size of every document's canvas, in document units, which `view.screenshot` draws.
const CANVAS: (u32, u32) = (40, 20);

/// The largest `scale` `view.screenshot` draws: `KITION_KIT_MOCK_MAX_SCALE`, 1 unless given.
static MAX_SCALE: LazyLock<f64> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_MAX_SCALE").ok().and_then(|value| value.trim().parse().ok()).filter(|scale: &f64| *scale >= 1.0).unwrap_or(1.0)
});

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    StdoutAfterReady,
    IgnoreToken,
}

impl Fault {
    pub fn from_env(value: &str) -> Self {
        match value {
            "stdout-after-ready" => Self::StdoutAfterReady,
            "ignore-token" => Self::IgnoreToken,
            _ => Self::None,
        }
    }
}

pub struct Connection {
    id: u64,
    role: Option<Role>,
    writer: Writer,
}

impl Connection {
    pub fn new(writer: Writer) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self { id: NEXT.fetch_add(1, Ordering::Relaxed), role: None, writer }
    }

    pub fn id(&self) -> u64 {
        self.id
    }
}

/// What the connection loop does after a message.
#[derive(Default)]
pub struct Step {
    pub reply: Option<Response>,
    pub broadcast: Vec<(Writer, Value)>,
    pub close: bool,
    pub shutdown: bool,
}

struct Document {
    id: String,
    /// The handle of the document's file (section 5).
    file: String,
    /// The file's display name.
    name: String,
    /// The version last read or written: a save replaces only it.
    version: Option<String>,
    /// The file changed since `version` while the text has unsaved edits.
    conflict: bool,
    text: String,
    history: Vec<String>,
    dirty: bool,
    read_only: bool,
    /// The document's object model, made on the first `model.*` request from its text.
    model: Option<Replica>,
    /// The current slide (counted from 0) when documents have slides ([`SLIDES`]): what
    /// `shape.text` edits. Not part of the document: no undo step, and saved only by a kit that
    /// writes its editor state into its file ([`STATE_IN_FILE`]).
    current: usize,
    /// The selected objects of the current slide (their ids), what `format.mark` marks; going to
    /// another slide clears it. Not part of the document either.
    selection: Vec<String>,
    /// The playhead, in seconds, when documents have a timeline ([`TIMELINE`]; `current` is then
    /// the open sequence, counted from 0). Editor state, never saved.
    playhead: f64,
    /// The editor's mode when documents have slides ([`SLIDES`]): `normal`, or `caps`, in which
    /// `shape.write` writes upper case. Editor state no call context sets: `mode.set` sets it, and
    /// `context.get` and `context.restore` keep it.
    mode: String,
}

/// A document's replica as a batch runs on it: no commands, and no writes when read-only.
struct MockTarget<'a> {
    replica: &'a mut Replica,
    read_only: bool,
}

impl BatchTarget for MockTarget<'_> {
    fn projected_objects(&mut self) -> Result<Vec<kition_kdm::projection::ProjectedObject>, BatchError> {
        if *crate::projected::PROJECTED {
            crate::projected::objects(self.replica).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error))
        } else {
            Ok(Vec::new())
        }
    }
    fn command_at(&mut self, id: &str, params: Value, context: &Value, origin: &Origin) -> Result<Value, String> {
        if *TRACKS && *BATCH_COMMANDS {
            let selection = context["on"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(str::to_owned).or_else(|| id.as_u64().map(|id| id.to_string())))
                .collect::<Vec<_>>();
            return tracks::edit(
                self.replica,
                id,
                &params.as_object().cloned().unwrap_or_default(),
                origin,
                context["time"].as_f64().unwrap_or(0.0),
                &selection,
                0,
            )
            .map(|edited| edited.result.unwrap_or(Value::Null));
        }
        if context.as_object().is_some_and(|context| !context.is_empty()) {
            return Err("mock adapter cannot apply this context".into());
        }
        self.command(id, params, origin)
    }
    fn value_limits(&mut self) -> Option<batch::ValueLimits> {
        std::env::var("KITION_KIT_MOCK_CONDITIONAL_LIMITS").is_ok().then(|| Box::new(|object:&Value,path:&str| {
            (path=="data.v").then(||serde_json::from_value(json!({"minimum":0,"maximum":if object["fields"]["data"]["kind"]=="percent" {1} else {10},"multipleOf":if object["fields"]["data"]["kind"]=="percent" {0.1} else {1.0}})).unwrap())
        }) as batch::ValueLimits)
    }
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(self.replica)
    }

    /// As a kit with tool ids does, numbers what the transaction created (OM9). A deck refuses
    /// a shape's text or colour that its file could not hold ([`deck::separators`]).
    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        let before_layers = self.replica.objects_of_type("Layer").len();
        batch::transact_replica(self.replica, origin, &mut |tx| {
            write(tx)?;
            if *crate::structure::STRUCTURE {
                crate::structure::settle(tx).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error.to_string()))?;
            }
            if *crate::matrix::MATRIX {
                crate::matrix::settle(tx).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error.to_string()))?;
            }
            if *crate::replay::REPLAY {
                crate::replay::settle(tx).map_err(|e| BatchError::new(BatchErrorCode::InvalidValue, None, e.to_string()))?;
            }
            if std::env::var("KITION_KIT_MOCK_DELETE_SIDE_EFFECT").is_ok()
                && tx.objects_of_type("Layer").len() < before_layers
                && let Some(layer) = tx.objects_of_type("Layer").first()
            {
                tx.set(layer, "fillOpacity", json!(0)).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error.to_string()))?;
            }
            if *crate::stack::STACK {
                crate::stack::settle_batch(tx).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error.to_string()))?;
            }
            if *DECK {
                // What the deck's file holds as text: a shape's text and colour, and in a nested
                // deck its paragraphs' text and the slides' notes.
                for (ty, field) in [("Shape", "text"), ("Shape", "color"), ("Paragraph", "text"), ("Note", "text")] {
                    for object in tx.objects_of_type(ty) {
                        if let Some(value) = tx.get(&object, field).ok().and_then(|value| value.as_str().map(str::to_owned)) {
                            deck::separators(field, &value).map_err(|message| BatchError::new(BatchErrorCode::InvalidValue, None, message))?;
                        }
                    }
                }
            }
            Ok(())
        })?;
        if *DECK && *deck::NESTED {
            deck::number_nested(self.replica).map_err(|message| BatchError::new(BatchErrorCode::InvalidValue, None, message))?;
        } else if self.replica.schema().has_tool_ids() {
            kition_kdm::testing::number_tool_ids(self.replica).map_err(|error| BatchError::new(BatchErrorCode::InvalidValue, None, error.to_string()))?;
        }
        Ok(())
    }

    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        if !*BATCH_COMMANDS {
            return Err(format!("`{id}` cannot run inside a batch of this kit"));
        }
        if *crate::order::ORDER && !*crate::matrix::MATRIX {
            return crate::order::edit(self.replica, id, &params.as_object().cloned().unwrap_or_default(), origin)
                .map(|edited| edited.result.unwrap_or(Value::Null));
        }
        if *crate::matrix::MATRIX {
            return crate::matrix::edit(self.replica, id, &params.as_object().cloned().unwrap_or_default(), origin)
                .map(|edited| edited.result.unwrap_or(Value::Null));
        }
        if *TRACKS {
            let given = params.as_object().cloned().unwrap_or_default();
            return tracks::edit(self.replica, id, &given, origin, 0.0, &[], 0).map(|edited| edited.result.unwrap_or(Value::Null));
        }
        if *DECK {
            // A deck's editing commands, as a real kit runs its commands inside a batch.
            let given = params.as_object().cloned().unwrap_or_default();
            return deck::edit(self.replica, id, &given, origin).map(|result| result.unwrap_or(Value::Null));
        }
        let root = batch::root_id(self.replica).ok_or("no root")?;
        let appended = match id {
            "text.append" => params.get("text").and_then(Value::as_str).ok_or("`text.append` takes `text`, a string")?.to_owned(),
            "text.clear" => String::new(),
            other => return Err(format!("unknown command `{other}`")),
        };
        self.replica
            .transact(origin, |tx| {
                let length = tx.text_len(&root, "text")?;
                if id == "text.clear" && length > 0 {
                    tx.text_delete(&root, "text", 0, length)?;
                }
                tx.text_insert(&root, "text", if id == "text.clear" { 0 } else { length }, &appended)
            })
            .map(|()| Value::Null)
            .map_err(|error| error.to_string())
    }

    fn read_only(&self) -> bool {
        self.read_only
    }
}

/// An object-model failure as the Kit Process Protocol answers it: `data.model` is `{ code, index, message }`.
fn model_error(error: &BatchError) -> RpcError {
    let reason = match error.code {
        BatchErrorCode::ReadOnly => ErrorReason::CommandDisabled,
        _ => ErrorReason::InvalidParams,
    };
    let mut rpc = RpcError::kit_detail(reason, error.to_string());
    if let Some(Value::Object(data)) = rpc.data.as_mut() {
        data.insert("model".into(), error.to_json());
    }
    rpc
}

impl Document {
    /// The object model, current with the text (a command may have changed it since).
    fn model(&mut self) -> Result<&mut Replica, RpcError> {
        let internal = |error: kition_kdm::KdmError| RpcError::internal(error.to_string());
        if *TRACKS {
            if self.model.is_none() {
                self.model = Some(tracks::build(&self.text).map_err(|message| RpcError::kit_detail(ErrorReason::UnsupportedFormat, message))?);
            }
            return self.model.as_mut().ok_or_else(|| RpcError::internal("no model"));
        }
        if *DECK {
            if self.model.is_none() {
                self.model = Some(deck::build(&self.text).map_err(|message| RpcError::kit_detail(ErrorReason::UnsupportedFormat, message))?);
            }
            return self.model.as_mut().ok_or_else(|| RpcError::internal("no model"));
        }
        if self.model.is_none() {
            let schema = Arc::new(Schema::parse(schema_text()).map_err(internal)?);
            let text = self.text.clone();
            let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
                let root = tx.create("Note", Map::new())?;
                tx.text_insert(&root, "text", 0, &text)
            })
            .map_err(internal)?;
            self.model = Some(replica);
        }
        let replica = self.model.as_mut().ok_or_else(|| RpcError::internal("no model"))?;
        let root = batch::root_id(replica).ok_or_else(|| RpcError::internal("no root"))?;
        if replica.text(&root, "text").map_err(internal)? != self.text {
            let text = self.text.clone();
            replica
                .transact(&Origin::system("text"), |tx| {
                    let length = tx.text_len(&root, "text")?;
                    if length > 0 {
                        tx.text_delete(&root, "text", 0, length)?;
                    }
                    tx.text_insert(&root, "text", 0, &text)
                })
                .map_err(internal)?;
        }
        Ok(replica)
    }

    /// Runs a batch; answers whether the text changed, and the batch's answer.
    fn batch(&mut self, request: &Value) -> Result<(bool, Value), RpcError> {
        let read_only = self.read_only;
        let before = self.text.clone();
        let replica = self.model()?;
        // A deck's text as the model writes it: a file another program wrote in another form
        // (comments, line endings) is not changed by a batch that changes nothing, a read.
        // A batch of no operations (a read) writes nothing: the deck's text is not written twice
        // for it, which on a deck of thousands of slides would cost more than the read.
        let reads_only = request["ops"].as_array().is_none_or(Vec::is_empty);
        let text_of = |replica: &Replica| if *TRACKS { tracks::text_of(replica) } else { deck::text_of(replica) };
        let written = if (*DECK || *TRACKS) && !reads_only { text_of(replica) } else { String::new() };
        let answer = batch::run(&mut MockTarget { replica, read_only }, request);
        if *DECK || *TRACKS {
            if reads_only {
                return answer.map(|answer| (false, answer)).map_err(|error| model_error(&error));
            }
            let text = text_of(replica);
            let writes = text != written;
            if writes {
                self.history.push(before);
                self.text = text;
                self.dirty = true;
            }
            return answer.map(|answer| (writes, answer)).map_err(|error| model_error(&error));
        }
        let root: ObjectId = batch::root_id(replica).ok_or_else(|| RpcError::internal("no root"))?;
        let text = replica.text(&root, "text").map_err(|error| RpcError::internal(error.to_string()))?;
        // A failed batch keeps the runs and commands before the failing operation, as the
        // object model says (KitObjectModel OM4): only a successful one is sure to change.
        let writes = if answer.is_ok() { request["ops"].as_array().is_some_and(|ops| !ops.is_empty()) } else { text != before };
        if writes {
            self.history.push(before);
            self.text = text;
            self.dirty = true;
        }
        answer.map(|answer| (writes, answer)).map_err(|error| model_error(&error))
    }

    fn state(&self) -> DocumentState {
        DocumentState {
            document_id: self.id.clone(),
            name: self.name.clone(),
            title: self.name.clone(),
            format: FORMAT.to_owned(),
            read_only: self.read_only,
            dirty: self.dirty,
            can_undo: !self.history.is_empty(),
            can_redo: false,
            conflict: self.conflict,
        }
    }
}

#[derive(Clone)]
struct PremisePlan {
    document: String,
    info: Value,
    before: Version,
    operations: usize,
    bytes: usize,
}

#[derive(Default)]
struct State {
    host_connected: bool,
    documents: Vec<Document>,
    next_document: u64,
    clients: HashMap<u64, Writer>,
    plans: HashMap<String, PremisePlan>,
}

/// The kit's requests to its host (`files.*`, section 5.1) and their answers.
#[derive(Default)]
struct HostLine {
    /// The host connection's id and writer.
    host: Option<(u64, Writer)>,
    pending: HashMap<i64, std::sync::mpsc::Sender<Result<Value, RpcError>>>,
    next: i64,
}

pub struct Kit {
    token: String,
    fault: Fault,
    wrote_fault_output: AtomicBool,
    state: Mutex<State>,
    host: Mutex<HostLine>,
    /// A read of a changed file put off ([`REREAD_LATE`]): the document, and whether a
    /// `model.version` of it was answered since.
    late: Mutex<Option<(String, bool)>>,
}

type Handled = Result<Value, RpcError>;

impl Kit {
    pub fn new(token: String, fault: Fault) -> Self {
        Self { token, fault, wrote_fault_output: AtomicBool::new(false), state: Mutex::new(State::default()), host: Mutex::default(), late: Mutex::default() }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn host_line(&self) -> std::sync::MutexGuard<'_, HostLine> {
        self.host.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The connection `connection` closed: a host's waiting requests fail at once. Answers whether
    /// it was the host's.
    pub fn disconnect(&self, connection: u64) -> bool {
        let mut line = self.host_line();
        let host = line.host.as_ref().is_some_and(|(id, _)| *id == connection);
        if host {
            line.host = None;
            line.pending.clear();
        }
        drop(line);
        let mut state = self.state();
        state.clients.remove(&connection);
        if host {
            state.host_connected = false;
        }
        host
    }

    /// An answer on connection `connection`: the host's answer to one of the kit's requests.
    pub fn answer(&self, connection: u64, response: Response) {
        let Some(RequestId::Number(id)) = response.id else { return };
        let mut line = self.host_line();
        if line.host.as_ref().is_none_or(|(host, _)| *host != connection) {
            return;
        }
        if let Some(waiting) = line.pending.remove(&id) {
            let _ = waiting.send(response.outcome);
        }
    }

    /// A request to the host, from the blocking thread a message is handled on.
    fn ask<M: HostServiceMethod>(&self, params: &M::Params) -> Result<M::Result, RpcError> {
        let (tx, rx) = std::sync::mpsc::channel();
        let (writer, id) = {
            let mut line = self.host_line();
            let writer = line
                .host
                .as_ref()
                .map(|(_, writer)| Arc::clone(writer))
                .ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host is not connected"))?;
            line.next += 1;
            let id = line.next;
            line.pending.insert(id, tx);
            (writer, id)
        };
        let params = serde_json::to_value(params).map_err(|error| RpcError::internal(error.to_string()))?;
        let request = Request { id: RequestId::Number(id), method: M::NAME.to_owned(), params: Some(params) }.to_value();
        let frame = framing::encode(&request).map_err(|error| RpcError::internal(error.to_string()))?;
        tokio::runtime::Handle::current().block_on(async {
            let mut writer = writer.lock().await;
            let _ = write_frame_async(&mut *writer, &frame).await;
        });
        let outcome = match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => {
                self.host_line().pending.remove(&id);
                Err(RpcError::kit_detail(ErrorReason::IoError, format!("the host did not answer {}", M::NAME)))
            }
        }?;
        serde_json::from_value(outcome).map_err(|error| RpcError::kit_detail(ErrorReason::IoError, format!("the host's answer to {}: {error}", M::NAME)))
    }

    /// A whole file, as text, and its version (a mock document is small: one chunk at a time).
    fn read_file(&self, handle: &str) -> Result<(String, String), RpcError> {
        let mut bytes = Vec::new();
        loop {
            let read = self.ask::<methods::FilesRead>(&FilesReadParams { handle: handle.to_owned(), offset: Some(bytes.len() as u64), length: None })?;
            let chunk = base64::decode(&read.data).ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host sent bytes that are not base64"))?;
            let done = chunk.is_empty() || (bytes.len() + chunk.len()) as u64 >= read.size;
            bytes.extend(chunk);
            if done {
                let text = String::from_utf8(bytes).map_err(|_| RpcError::kit_detail(ErrorReason::UnsupportedFormat, "the file is not UTF-8 text"))?;
                return Ok((text, read.version));
            }
        }
    }

    /// Writes `text` to the file of `handle` and commits it; answers the committed version.
    fn write_file(&self, handle: &str, text: &str, expected: Option<String>) -> Result<String, RpcError> {
        let chunk = FilesWriteParams { handle: handle.to_owned(), data: base64::encode(text.as_bytes()), offset: 0, last: Some(true), expected };
        self.ask::<methods::FilesWrite>(&chunk)?.version.ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host committed no version"))
    }

    pub fn handle(&self, connection: &mut Connection, message: Message) -> Step {
        if self.fault == Fault::StdoutAfterReady && !self.wrote_fault_output.swap(true, Ordering::SeqCst) {
            println!("unexpected output");
        }
        match message {
            Message::Request(request) => self.handle_request(connection, request),
            Message::Notification(notification) => self.handle_notification(connection, notification),
            // Answers are routed by the connection loop before a message gets here.
            Message::Response(_) => Step::default(),
        }
    }

    fn handle_request(&self, connection: &mut Connection, request: Request) -> Step {
        let mut step = Step::default();
        let params = request.params.unwrap_or_else(|| json!({}));
        let late = {
            let mut late = self.late.lock().unwrap_or_else(PoisonError::into_inner);
            if late.as_ref().is_some_and(|(_, armed)| *armed) { late.take() } else { None }
        };
        if let Some((document, _)) = late {
            self.reload(&document, &mut step);
        }
        let version_of = (request.method == "model.version").then(|| params["documentId"].clone());
        let outcome = match connection.role {
            None if request.method == methods::Initialize::NAME => {
                let outcome = self.initialize(connection, params);
                step.close = outcome.as_ref().is_err_and(|error| error.reason() == Some(ErrorReason::Unauthorized));
                outcome
            }
            None => Err(RpcError::kit(ErrorReason::NotInitialized)),
            Some(Role::Agent) if methods::is_host_only(&request.method) => Err(RpcError::kit(ErrorReason::RoleForbidden)),
            // As a kit process serving `kition-kit-server` refuses it (Kit Process Protocol, section
            // 1): a batch on the agent's connection is the agent's, reads included, so it names
            // the agent as its origin. A host that forgets it fails here as it would on a real kit.
            Some(Role::Agent) if request.method == "model.batch" && params["origin"]["kind"] != "agent" => {
                Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "an agent's connection sends batches with origin { kind: agent, principal }"))
            }
            Some(role) => self.dispatch(role, &request.method, params, &mut step),
        };
        step.reply = Some(Response { id: Some(request.id), outcome });
        if let Some(asked) = version_of
            && let Some((document, armed)) = self.late.lock().unwrap_or_else(PoisonError::into_inner).as_mut()
            && asked == document.as_str()
        {
            *armed = true;
        }
        step
    }

    fn handle_notification(&self, connection: &Connection, notification: Notification) -> Step {
        let mut step = Step::default();
        if connection.role == Some(Role::Host)
            && notification.method == methods::DocumentDidChangeOnDisk::NAME
            && let Ok(params) = parse::<DocumentRef>(notification.params.unwrap_or_else(|| json!({})))
        {
            if *REREAD_LATE {
                *self.late.lock().unwrap_or_else(PoisonError::into_inner) = Some((params.document_id, false));
                return step;
            }
            self.reload(&params.document_id, &mut step);
        }
        step
    }

    fn initialize(&self, connection: &mut Connection, params: Value) -> Handled {
        let params: InitializeParams = parse(params)?;
        if params.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::kit_detail(ErrorReason::UnsupportedProtocol, format!("this kit speaks Kit Process Protocol version {PROTOCOL_VERSION}")));
        }
        if params.token != self.token && self.fault != Fault::IgnoreToken {
            return Err(RpcError::kit(ErrorReason::Unauthorized));
        }
        let mut state = self.state();
        match params.role {
            Role::Host if state.host_connected => {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "a host is already connected"));
            }
            Role::Agent if !state.host_connected => {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "the host has not initialized"));
            }
            Role::Host => {
                state.host_connected = true;
                state.documents.clear();
                *self.host_line() = HostLine { host: Some((connection.id, Arc::clone(&connection.writer))), pending: HashMap::new(), next: 0 };
            }
            Role::Agent => {}
        }
        state.clients.insert(connection.id, Arc::clone(&connection.writer));
        connection.role = Some(params.role);
        to_value(InitializeResult {
            protocol_version: PROTOCOL_VERSION,
            kit: KitInfo { id: IDENTITY.0.clone(), version: VERSION.clone() },
            capabilities: Capabilities {
                surfaces: vec![Surface::Headless],
                formats: Formats { open: vec![FORMAT.to_owned()], save: vec![FORMAT.to_owned()], export: vec![FORMAT.to_owned()] },
                features: match (*MODEL, *FILE_REPLICA) {
                    (true, true) => vec!["view.describe".to_owned(), "model.describe".to_owned(), "model.batch".to_owned(), "document.identity".to_owned()],
                    (true, false) => vec!["view.describe".to_owned(), "model.describe".to_owned(), "model.batch".to_owned()],
                    (false, _) => vec!["view.describe".to_owned()],
                },
                capabilities: Vec::new(),
            },
        })
    }

    fn dispatch(&self, role: Role, method: &str, params: Value, step: &mut Step) -> Handled {
        match method {
            methods::Ping::NAME | methods::SetPreferences::NAME => to_value(Empty {}),
            methods::Shutdown::NAME => {
                step.shutdown = true;
                to_value(Empty {})
            }
            methods::DocumentOpen::NAME => self.open(parse(params)?, step),
            methods::DocumentList::NAME => {
                let documents = self.state().documents.iter().map(Document::state).collect();
                to_value(DocumentListResult { documents })
            }
            methods::DocumentActivate::NAME => {
                let params: DocumentRef = parse(params)?;
                self.with_document(&params.document_id, |_| Ok(()))?;
                to_value(Empty {})
            }
            methods::DocumentSave::NAME => {
                let params: DocumentRef = parse(params)?;
                self.save(&params.document_id, None, step)
            }
            methods::DocumentSaveAs::NAME => {
                let params: DocumentSaveAsParams = parse(params)?;
                if params.format.as_deref().is_some_and(|format| format != FORMAT) {
                    return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
                }
                self.save(&params.document_id, Some(params.file), step)
            }
            methods::DocumentExport::NAME => {
                let params: DocumentExportParams = parse(params)?;
                if params.format != FORMAT {
                    return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
                }
                let text = self.with_document(&params.document_id, |document| Ok(document.text.clone()))?;
                let stat = self.ask::<methods::FilesStat>(&FileRef { handle: params.file.clone() })?;
                let version = self.write_file(&params.file, &text, None)?;
                to_value(DocumentWritten { name: stat.name, version })
            }
            methods::DocumentReload::NAME => {
                let params: DocumentRef = parse(params)?;
                let state = self.read_again(&params.document_id)?;
                self.broadcast::<methods::DocumentDidChangeState>(&state, step);
                to_value(state)
            }
            methods::DocumentClose::NAME => {
                let params: DocumentCloseParams = parse(params)?;
                let mut state = self.state();
                let index = state
                    .documents
                    .iter()
                    .position(|document| document.id == params.document_id)
                    .ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                if state.documents[index].dirty && params.discard_changes != Some(true) {
                    return Err(RpcError::kit(ErrorReason::DocumentDirty));
                }
                state.documents.remove(index);
                to_value(Empty {})
            }
            methods::CommandsList::NAME => {
                let params: CommandsListParams = parse(params)?;
                self.list_commands(&params)
            }
            methods::CommandsExecute::NAME => {
                let params: CommandsExecuteParams = parse(params)?;
                if params.origin == kition_kit_process_protocol::types::Origin::System && role != Role::Host {
                    return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "only the host sends origin system"));
                }
                self.execute(params, step)
            }
            methods::ViewScreenshot::NAME => {
                let params: ViewScreenshotParams = parse(params)?;
                self.with_document(&params.document_id, |_| Ok(()))?;
                screenshot(&params)
            }
            methods::ViewDescribe::NAME => {
                let params: DocumentRef = parse(params)?;
                let (text, current, selection, playhead, mode) = self.with_document(&params.document_id, |document| {
                    Ok((document.text.clone(), document.current, document.selection.clone(), document.playhead, document.mode.clone()))
                })?;
                if *TIMELINE {
                    let count = slides_of(&text).len();
                    return to_value(ViewDescribeResult {
                        summary: format!("{count} sequences"),
                        state: Map::from_iter([
                            ("text".to_owned(), json!(text)),
                            ("sequence".to_owned(), json!(current + 1)),
                            ("playhead".to_owned(), json!(playhead)),
                        ]),
                    });
                }
                if *TRACKS {
                    let count = self.with_document(&params.document_id, |document| Ok(tracks::count(document.model()?)))?;
                    return to_value(ViewDescribeResult {
                        summary: format!("{count} tracks"),
                        state: Map::from_iter([("text".to_owned(), json!(text)), ("selection".to_owned(), json!(selection))]),
                    });
                }
                if *DECK {
                    let count = self.with_document(&params.document_id, |document| Ok(deck::count(document.model()?)))?;
                    return to_value(ViewDescribeResult {
                        summary: format!("{count} slides"),
                        state: Map::from_iter([
                            ("text".to_owned(), json!(text)),
                            ("slide".to_owned(), json!(current + 1)),
                            ("selection".to_owned(), json!(selection)),
                        ]),
                    });
                }
                if *SLIDES {
                    let count = slides_of(&text).len();
                    return to_value(ViewDescribeResult {
                        summary: format!("{count} slides"),
                        state: Map::from_iter([
                            ("text".to_owned(), json!(text)),
                            ("slide".to_owned(), json!(current + 1)),
                            ("selection".to_owned(), json!(selection)),
                            ("mode".to_owned(), json!(mode)),
                        ]),
                    });
                }
                to_value(ViewDescribeResult {
                    summary: format!("{} characters", text.chars().count()),
                    state: Map::from_iter([("text".to_owned(), json!(text)), ("length".to_owned(), json!(text.chars().count()))]),
                })
            }
            "document.check" => {
                let params: DocumentRef = parse(params)?;
                let text = self.with_document(&params.document_id, |document| Ok(document.text.clone()))?;
                let mut diagnostics: Vec<Value> = if text.contains(TODO) {
                    vec![json!({ "code": TODO_CODE, "severity": "warning", "target": {}, "message": "The text has a TODO left in it." })]
                } else {
                    Vec::new()
                };
                if *DECK {
                    diagnostics.extend(self.with_document(&params.document_id, |document| Ok(deck::diagnostics(document.model()?)))?);
                }
                Ok(json!({ "diagnostics": diagnostics }))
            }
            "document.identity" if *FILE_REPLICA => {
                let params: DocumentIdentityParams = parse(params)?;
                let (text, _) = self.read_file(&params.file)?;
                let (_, embedded) = split_file(text)?;
                to_value(DocumentIdentityResult { doc_id: embedded.map(|replica| replica.doc_id().to_string()) })
            }
            "document.fork" if *FILE_REPLICA => self.fork(parse(params)?),
            method if method.starts_with("model.") && !*MODEL => Err(RpcError::method_not_found(method)),
            "model.import" if *FILE_REPLICA => {
                let id = document_param(&params)?;
                let changes = params["changes"].as_str().and_then(base64::decode).ok_or_else(|| RpcError::invalid_params("changes is base64 KDM"))?;
                self.with_document(&id, |document| {
                    let replica = document.model()?;
                    replica.import_changes(&changes).map_err(|error| RpcError::kit_detail(ErrorReason::InvalidParams, error.to_string()))?;
                    let root = batch::root_id(replica).ok_or_else(|| RpcError::internal("no root"))?;
                    document.text = replica.text(&root, "text").map_err(|error| RpcError::internal(error.to_string()))?;
                    Ok(json!({}))
                })
            }
            "model.export" if *FILE_REPLICA || matches!(REPLICA.as_str(), "full" | "export") => {
                let id = document_param(&params)?;
                // A file that keeps its replica answers as a kit on the change exchange does
                // (`with_replica_port`): the replica's changes since `since`, every change without
                // one. The other modes answer a snapshot.
                let since = match params["since"].as_str() {
                    Some(since) if *FILE_REPLICA => base64::decode(since)
                        .and_then(|bytes| kition_kdm::Version::decode(&bytes).ok())
                        .ok_or_else(|| RpcError::invalid_params("`since` is a base64 version, as `model.version` answers it"))?,
                    _ => kition_kdm::Version::empty(),
                };
                self.with_document(&id, |document| {
                    let replica = document.model()?;
                    let bytes = if *FILE_REPLICA { replica.export_changes(&since) } else { replica.snapshot() };
                    Ok(json!({ "changes": base64::encode(&bytes.map_err(|error| RpcError::internal(error.to_string()))?) }))
                })
            }
            "model.open" if REPLICA.as_str() == "full" => {
                let bytes = params["snapshot"].as_str().and_then(base64::decode).ok_or_else(|| RpcError::invalid_params("snapshot is base64 KDM"))?;
                let schema = Arc::new(Schema::parse(schema_text()).map_err(|error| RpcError::internal(error.to_string()))?);
                let replica = Replica::load(schema, &bytes, ActorId::random()).map_err(|error| RpcError::internal(error.to_string()))?;
                let text = if *TRACKS {
                    tracks::text_of(&replica)
                } else if *DECK {
                    deck::text_of(&replica)
                } else {
                    let root = batch::root_id(&replica).ok_or_else(|| RpcError::internal("no root"))?;
                    replica.text(&root, "text").map_err(|error| RpcError::internal(error.to_string()))?
                };
                let mut state = self.state();
                state.next_document += 1;
                let document = Document {
                    id: format!("doc-{}", state.next_document),
                    file: String::new(),
                    name: params["name"].as_str().unwrap_or("Draft").to_owned(),
                    version: None,
                    conflict: false,
                    text,
                    history: Vec::new(),
                    dirty: false,
                    read_only: false,
                    model: Some(replica),
                    current: 0,
                    selection: Vec::new(),
                    playhead: 0.0,
                    mode: "normal".to_owned(),
                };
                let answer = json!({ "documentId": document.id });
                state.documents.push(document);
                Ok(answer)
            }
            "model.save" if REPLICA.as_str() == "full" => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| Ok(json!({ "data": base64::encode(document.text.as_bytes()) })))
            }
            "model.version" => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| Ok(json!({ "version": base64::encode(&document.model()?.version().encode()) })))
            }
            "model.changes" => {
                let id = document_param(&params)?;
                let since = params["since"]
                    .as_str()
                    .and_then(base64::decode)
                    .and_then(|bytes| kition_kdm::Version::decode(&bytes).ok())
                    .ok_or_else(|| RpcError::invalid_params("`since` is a base64 version, as `model.version` answers it"))?;
                self.with_document(&id, |document| {
                    let replica = document.model()?;
                    let version = base64::encode(&replica.version().encode());
                    Ok(match replica.changes_since(&since) {
                        Ok(changes) => json!({ "changes": changes.to_recorded_json(replica.schema()), "version": version }),
                        Err(error) => json!({ "changes": null, "unavailable": error.to_string(), "version": version }),
                    })
                })
            }
            "model.describe" => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| {
                    let mut described = batch::describe(document.model()?);
                    if *crate::raster::RASTER {
                        described["blobBytes"] = json!(true);
                    }
                    // Replica fixtures retain their real schema identity (`kit.mock`) even
                    // when the executable stands in for a differently named manifest.
                    if REPLICA.is_empty() {
                        described["kit"] = json!(IDENTITY.0);
                    }
                    described["commands"] = json!(["text.append", "text.clear", "edit.undo"]);
                    if IDENTITY.0 != "kit.batchcontract" {
                        for def in described["types"].as_object_mut().into_iter().flat_map(|types| types.values_mut()) {
                            if !*crate::comments::COMMENTS {
                                def["batchOps"] = json!({"*":{"direct":true}});
                            }
                        }
                        if IDENTITY.0 == "kit.batchmapped" {
                            described["types"]["Clip"]["batchOps"]["set.opacity"] =
                                json!({"command":"clip.opacity","params":{"clip":"target","opacity":"value"}});
                        }
                    }
                    Ok(described)
                })
            }
            "context.get" | "context.set" | "context.restore" if *CONTEXT => self.context(method, &params),
            "context.plan" => self.premise_plan(&params),
            "context.under" if *CONTEXT && *TRACKS => self.context(method, &params),
            "context.under" if *CONTEXT && *DECK => {
                let id = document_param(&params)?;
                if matches!(params["command"].as_str(), Some("edit.undo" | "edit.redo")) {
                    return self.with_document(&id, |document| {
                        let replica = document.model()?;
                        let scope = params["params"]["scope"].as_str().and_then(kition_kdm::UndoScope::parse).unwrap_or(kition_kdm::UndoScope::Agent);
                        let touches = if params["command"] == "edit.undo" { replica.undo_touches_in(scope) } else { replica.redo_touches_in(scope) };
                        let ids = kition_kdm::tool_ids::ToolIds::of_replica(replica);
                        Ok(json!({"objects":[],"premises":touches.into_iter().map(|touch| {
                            let mut premise = json!({"id":ids.show(&ObjectId::from_string(touch.id))});
                            if let Some(fields) = touch.fields { premise["fields"] = json!(fields); }
                            premise
                        }).collect::<Vec<_>>()}))
                    });
                }
                if params["command"] != "slide.insert" {
                    return Ok(Value::Null);
                }
                let index = params["params"]["index"].as_u64().ok_or_else(|| RpcError::invalid_params("index is required"))?;
                self.with_document(&id, |document| {
                    let root = document.model()?.objects_of_type("Deck").into_iter().next().ok_or_else(|| RpcError::internal("no root"))?;
                    Ok(json!({ "objects": [], "within": [{ "parent": root.as_str(), "field": "slides", "from": index, "to": index }] }))
                })
            }
            // A scene's places in space: whether the objects others changed were under
            // a place at `basis`, from their values then; nothing changes.
            "context.content" if *crate::matrix::MATRIX => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| crate::matrix::derived_content(document.model()?, &params).map_err(RpcError::invalid_params))
            }
            "context.content" if *crate::raster::RASTER => {
                let id = document_param(&params)?;
                let old = self.history_blob(&params, params["before"]["hash"].as_str().unwrap_or_default(), 0, 4)?;
                let changed = if old["available"] == true {
                    let old = old["data"].as_str().and_then(base64::decode);
                    self.with_document(&id, |document| {
                        let now = crate::raster::pixels(document.model()?);
                        let region = &params["region"];
                        let (x, y, w, h) = (
                            region[0].as_u64().unwrap_or(0),
                            region[1].as_u64().unwrap_or(0),
                            region[2].as_u64().unwrap_or(0),
                            region[3].as_u64().unwrap_or(0),
                        );
                        Ok(old.map(|old| (y..y + h).any(|y| (x..x + w).any(|x| old.get((y * 2 + x) as usize) != now.get((y * 2 + x) as usize)))))
                    })?
                } else {
                    None
                };
                Ok(json!({"changed":changed}))
            }
            "context.covered" if *crate::raster::RASTER => {
                let id = document_param(&params)?;
                let index = crate::raster::index(&params["params"]);
                let objects = params["objects"].as_array().cloned().unwrap_or_default();
                let mut covered = Vec::new();
                let mut under = Some(Vec::new());
                for object in &objects {
                    let hash = object["before"]["tile"]["hash"].as_str().unwrap_or_default();
                    let result = self.history_blob(&params, hash, index, 2)?;
                    let hit = if result["available"] == true {
                        result["data"].as_str().and_then(base64::decode).and_then(|bytes| bytes.first().map(|v| *v != 0))
                    } else {
                        None
                    };
                    let mut answer = json!({"id":object["id"],"covered":hit});
                    if std::env::var_os("KITION_KIT_MOCK_COVERED_CONTENT").is_some() {
                        let before = result["data"].as_str().and_then(base64::decode).and_then(|bytes| bytes.first().copied());
                        let now = self.with_document(&id, |document| Ok(crate::raster::pixels(document.model()?).get(index).copied()))?;
                        answer["content"] = json!(match (before, now) {
                            (Some(before), Some(now)) if before == now => "same",
                            (Some(_), Some(_)) => "changed",
                            _ => "unknown",
                        });
                    }
                    covered.push(answer);
                    match hit {
                        Some(true) => {
                            if let Some(under) = &mut under {
                                under.push(object["id"].clone());
                            }
                        }
                        None => under = None,
                        _ => {}
                    }
                }
                let _ = id;
                Ok(json!({"covered":covered,"under":under}))
            }
            "model.blob.read" if *crate::raster::RASTER => {
                let id = document_param(&params)?;
                self.with_document(&id,|document|{
                    let replica=document.model()?;
                    if params["hash"]!=crate::raster::hash(replica) {return Ok(json!({"available":false,"reason":"missing"}));}
                    let mut bytes=crate::raster::pixels(replica);
                    if std::env::var_os("KITION_KIT_MOCK_CORRUPT_BLOB").is_some() && let Some(first)=bytes.first_mut() { *first^=1; }
                    let offset=params["offset"].as_u64().unwrap_or(0) as usize;
                    let length=params["length"].as_u64().unwrap_or(0) as usize;
                    Ok(json!({"available":true,"size":bytes.len(),"data":base64::encode(bytes.get(offset..offset.saturating_add(length).min(bytes.len())).unwrap_or_default())}))
                })
            }
            "context.covered" if *crate::structure::STRUCTURE => {
                Ok(crate::structure::covered(params["objects"].as_array().map(Vec::as_slice).unwrap_or_default()))
            }
            "context.covered" if *crate::matrix::MATRIX => {
                let id = document_param(&params)?;
                let objects = params["objects"].as_array().cloned().unwrap_or_default();
                self.with_document(&id, |document| crate::matrix::covered(document.model()?, &params["params"], &objects).map_err(RpcError::invalid_params))
            }
            "context.covered" if *CONTEXT && *SPACE => {
                let id = document_param(&params)?;
                let given = params["params"].as_object().cloned().unwrap_or_default();
                let objects = params["objects"].as_array().cloned().ok_or_else(|| RpcError::invalid_params("`objects` lists the objects to ask about"))?;
                self.with_document(&id, |document| space::covered(document.model()?, &given, &objects).map_err(RpcError::invalid_params))
            }
            "context.identity" if *crate::matrix::MATRIX => {
                let unproven = std::env::var("KITION_KIT_MOCK_UNPROVEN").unwrap_or_default();
                Ok(
                    json!({"unproven":params["objects"].as_array().into_iter().flatten().filter(|id| id.as_str().is_some_and(|id| id == unproven || id == "Alpha" && unproven == "A")).cloned().collect::<Vec<_>>()}),
                )
            }
            "context.inputs" if *crate::matrix::MATRIX => {
                let path = std::env::var("KITION_KIT_MOCK_INPUT").unwrap_or_default();
                let inputs = if std::path::Path::new(&format!("{path}.registered")).is_file() {
                    let fingerprint = std::fs::read(&path).ok().map(|bytes| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
                    json!([{"name":"library","fingerprint":fingerprint}])
                } else {
                    json!([])
                };
                Ok(json!({"inputs":inputs}))
            }
            // A scene's derived values: computed now, never stored.
            "model.derived" if *crate::matrix::MATRIX && std::env::var_os("KITION_KIT_MOCK_DERIVED").is_some() => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| crate::matrix::derived(document.model()?, params["ids"].as_array()).map_err(RpcError::invalid_params))
            }
            "model.derived" if *SPACE => {
                let id = document_param(&params)?;
                let ids = params["ids"].as_array().cloned();
                let names: Option<Vec<String>> = params["names"].as_array().map(|names| names.iter().filter_map(Value::as_str).map(str::to_owned).collect());
                self.with_document(&id, |document| space::derived(document.model()?, ids.as_deref(), names.as_deref()).map_err(RpcError::invalid_params))
            }
            // An image's derived value: the root's, by its object id.
            "model.derived" if *crate::stack::STACK => {
                let id = document_param(&params)?;
                let ids = params["ids"].as_array().cloned();
                self.with_document(&id, |document| crate::stack::derived(document.model()?, ids.as_deref()).map_err(RpcError::invalid_params))
            }
            // What a scene's changes carry: a node's descendants, in world space.
            "model.carried" if *SPACE => {
                let id = document_param(&params)?;
                let ids = params["ids"].as_array().cloned().unwrap_or_default();
                let changes = params["changes"].as_array().cloned().unwrap_or_default();
                self.with_document(&id, |document| space::carried(document.model()?, &ids, &changes).map_err(RpcError::invalid_params))
            }
            "model.batch" => {
                let id = document_param(&params)?;
                let (changed, answer) = self.with_document(&id, |document| document.batch(&params))?;
                if changed {
                    let state = self.with_document(&id, |document| Ok(document.state()))?;
                    self.broadcast::<methods::DocumentDidChangeState>(&state, step);
                }
                Ok(answer)
            }
            method => Err(RpcError::method_not_found(method)),
        }
    }

    /// `document.open`. A file already open answers its document; when the file changed since it
    /// was read and the document has no unsaved edits, it is read again first, as kition-headless
    /// does, so a caller that opens a document to see it as it was sees the file as it is.
    fn open(&self, params: DocumentOpenParams, step: &mut Step) -> Handled {
        let open = self
            .state()
            .documents
            .iter()
            .find(|document| document.file == params.file)
            .map(|document| (document.id.clone(), document.dirty, document.version.clone()));
        let stat = self.ask::<methods::FilesStat>(&FileRef { handle: params.file.clone() })?;
        if let Some((id, dirty, version)) = open {
            if !dirty && version.is_some() && version != stat.version {
                let state = self.read_again(&id)?;
                self.broadcast::<methods::DocumentDidChangeState>(&state, step);
                return to_value(state);
            }
            return to_value(self.with_document(&id, |document| Ok(document.state()))?);
        }
        if stat.name.rsplit_once('.').map(|(_, extension)| extension) != Some(IDENTITY.1.as_str()) {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        if let Some(create) = &params.create
            && create.format != IDENTITY.2
        {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        let created = params.create.is_some() && stat.version.is_none();
        let (text, version) = if created { (String::new(), None) } else { self.read_file(&params.file).map(|(text, version)| (text, Some(version)))? };
        let (text, embedded) = split_file(text)?;
        let (text, current) = editor_line(text);
        let mut state = self.state();
        state.next_document += 1;
        let document = Document {
            id: format!("doc-{}", state.next_document),
            file: params.file,
            name: stat.name,
            version,
            conflict: false,
            dirty: created,
            text,
            history: Vec::new(),
            read_only: params.read_only == Some(true),
            model: embedded,
            current,
            selection: Vec::new(),
            playhead: 0.0,
            mode: "normal".to_owned(),
        };
        let document_state = document.state();
        state.documents.push(document);
        drop(state);
        self.broadcast::<methods::DocumentDidChangeState>(&document_state, step);
        to_value(document_state)
    }

    /// `document.fork`: the file of `params.file` as a new document, written to `params.target`. Its
    /// embedded replica is replaced by a copy under a new docId (no history: KDM
    /// `copy_as_new_document`); a file without one is written unchanged and has no identity.
    fn fork(&self, params: DocumentForkParams) -> Handled {
        let (text, _) = self.read_file(&params.file)?;
        let (body, embedded) = split_file(text.clone())?;
        let (contents, doc_id) = match embedded {
            None => (text, None),
            Some(source) => {
                let doc_id = DocId::new();
                let copy = source.copy_as_new_document(doc_id, ActorId::random()).map_err(|error| RpcError::internal(error.to_string()))?;
                (joined_file(&body, Some(&copy))?, Some(doc_id.to_string()))
            }
        };
        let stat = self.ask::<methods::FilesStat>(&FileRef { handle: params.target.clone() })?;
        // A fork never replaces a file: the target is a `create` handle, committed once.
        let version = self.write_file(&params.target, &contents, None)?;
        to_value(DocumentForkResult { doc_id, name: stat.name, version })
    }

    /// Writes the document to its file (or to `target`'s, which it then lives in), committed with
    /// the version it read: a file changed meanwhile is the host's `file_conflict`.
    fn save(&self, document_id: &str, target: Option<String>, step: &mut Step) -> Handled {
        // A failed save of the document's own file is a conflict (saving elsewhere is not).
        let own_file = target.is_none();
        let (text, current, handle, name, expected, replica) = self.with_document(document_id, |document| {
            if document.read_only && target.is_none() {
                return Err(RpcError::kit_detail(ErrorReason::IoError, "the document is read-only"));
            }
            let replica = if *FILE_REPLICA { Some(document.model()?.snapshot().map_err(|error| RpcError::internal(error.to_string()))?) } else { None };
            Ok((document.text.clone(), document.current, document.file.clone(), document.name.clone(), document.version.clone(), replica))
        })?;
        let (handle, name, expected) = match target {
            Some(target) => {
                let stat = self.ask::<methods::FilesStat>(&FileRef { handle: target.clone() })?;
                (target, stat.name, stat.version)
            }
            None => (handle, name, expected),
        };
        let mut contents = file_text(&text, current);
        if let Some(snapshot) = &replica {
            contents = format!("{contents}{REPLICA_MARK}{}", base64::encode(snapshot));
        }
        let version = match self.write_file(&handle, &contents, expected) {
            Ok(version) => version,
            Err(error) => {
                if error.reason() == Some(ErrorReason::FileConflict) && own_file {
                    let _ = self.with_document(document_id, |document| {
                        document.conflict = true;
                        Ok(())
                    });
                }
                return Err(error);
            }
        };
        let saved = self.with_document(document_id, |document| {
            document.conflict = false;
            document.file = handle;
            document.name = name.clone();
            document.version = Some(version.clone());
            document.dirty = document.text != text;
            Ok(document.state())
        })?;
        let written = DocumentWritten { name, version };
        self.broadcast::<methods::DocumentDidSave>(
            &DocumentDidSaveParams { document_id: document_id.to_owned(), name: written.name.clone(), version: written.version.clone() },
            step,
        );
        self.broadcast::<methods::DocumentDidChangeState>(&saved, step);
        to_value(written)
    }

    /// `document.didChangeOnDisk`: a clean text is read again; one with unsaved edits keeps them
    /// and is in conflict when the file's version moved.
    fn reload(&self, document_id: &str, step: &mut Step) {
        let Ok((file, dirty, version, conflict)) =
            self.with_document(document_id, |document| Ok((document.file.clone(), document.dirty, document.version.clone(), document.conflict)))
        else {
            return;
        };
        if dirty {
            let Ok(stat) = self.ask::<methods::FilesStat>(&FileRef { handle: file }) else { return };
            if conflict || stat.version == version {
                return;
            }
            if let Ok(state) = self.with_document(document_id, |document| {
                document.conflict = true;
                Ok(document.state())
            }) {
                self.broadcast::<methods::DocumentDidChangeState>(&state, step);
            }
            return;
        }
        if let Ok(state) = self.read_again(document_id) {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
    }

    /// `document.reload`: the file's text again, its unsaved edits dropped.
    fn read_again(&self, document_id: &str) -> Result<DocumentState, RpcError> {
        let file = self.with_document(document_id, |document| Ok(document.file.clone()))?;
        let (text, version) = self.read_file(&file)?;
        let (text, embedded) = split_file(text)?;
        let (text, current) = editor_line(text);
        self.with_document(document_id, |document| {
            if *DECK && !*deck::NESTED && std::env::var_os("KITION_KIT_MOCK_RETAIN_SESSION").is_some() {
                if let Some(replica) = document.model.as_mut() {
                    deck::reread(replica, &text).map_err(RpcError::internal)?;
                }
                document.text = text;
                document.version = Some(version);
                document.dirty = false;
                document.conflict = false;
                return Ok(document.state());
            }
            let carried = if *crate::matrix::MATRIX && std::env::var_os("KITION_KIT_MOCK_CARRY").is_some() {
                let mut next = crate::matrix::build(&text).map_err(RpcError::internal)?;
                if let Some(previous) = document.model.as_ref() {
                    crate::matrix::carry_replica_objects(previous, &mut next).map_err(RpcError::internal)?;
                }
                Some(next)
            } else {
                None
            };
            document.text = text;
            if *STATE_IN_FILE {
                document.current = current;
            }
            document.version = Some(version);
            // The document is replaced: its object model starts again from the text (or from the
            // replica the file embeds).
            document.model = carried.or(embedded);
            document.history.clear();
            document.dirty = false;
            document.conflict = false;
            Ok(document.state())
        })
    }

    fn list_commands(&self, params: &CommandsListParams) -> Handled {
        let (empty, can_undo, read_only) = match &params.document_id {
            Some(id) => self.with_document(id, |document| Ok((document.text.is_empty(), !document.history.is_empty(), document.read_only)))?,
            None => (true, false, false),
        };
        let mut commands = vec![
            CommandInfo {
                // Searched, never listed (an agent finds the command by words its title lacks).
                keywords: vec!["Boilerplate".to_owned(), "Lorem ipsum".to_owned()],
                id: "text.append".to_owned(),
                title: "Append text".to_owned(),
                description: Some("Appends text to the end of the document.".to_owned()),
                group: "text".to_owned(),
                params: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["text"],
                    "properties": { "text": { "type": "string", "minLength": 1 } }
                }),
                output: None,
                mutates: true,
                enabled: !read_only,
                menu: Vec::new(),
                shortcut: None,
            },
            CommandInfo {
                keywords: Vec::new(),
                id: "text.clear".to_owned(),
                title: "Clear".to_owned(),
                description: Some("Removes all text.".to_owned()),
                group: "text".to_owned(),
                params: json!({ "type": "object", "additionalProperties": false }),
                output: None,
                mutates: true,
                enabled: !read_only && !empty,
                menu: Vec::new(),
                shortcut: None,
            },
            CommandInfo {
                keywords: Vec::new(),
                id: "edit.undo".to_owned(),
                title: "Undo".to_owned(),
                description: None,
                group: "edit".to_owned(),
                // Engine contract 2 E14a: the undo scope, else the origin's.
                params: json!({ "type": "object", "additionalProperties": false, "properties": { "scope": { "enum": ["person", "agent"] } } }),
                output: None,
                mutates: true,
                enabled: !read_only && can_undo,
                menu: Vec::new(),
                shortcut: None,
            },
        ];
        if std::env::var_os("KITION_KIT_MOCK_CLOSE").is_some() {
            commands.push(CommandInfo {
                id: "file.close".into(),
                title: "Close".into(),
                description: None,
                group: "file".into(),
                params: json!({"type":"object","properties":{"force":{"type":"boolean"}}}),
                output: None,
                mutates: false,
                enabled: true,
                menu: Vec::new(),
                shortcut: None,
                keywords: Vec::new(),
            });
        }
        if std::env::var_os("KITION_KIT_MOCK_TEXT_INSERT").is_some() {
            commands.push(CommandInfo {
                id: "text.insert".into(),
                title: "Insert text".into(),
                description: None,
                group: "edit".into(),
                params: json!({"type":"object","properties":{"at":{"type":"integer","minimum":0},"text":{"type":"string"}},"required":["at","text"]}),
                output: None,
                mutates: true,
                enabled: !read_only,
                menu: Vec::new(),
                shortcut: None,
                keywords: Vec::new(),
            });
        }
        if *TRACKS {
            let commands =
                tracks_commands().into_iter().filter(|command| params.groups.as_ref().is_none_or(|groups| groups.contains(&command.group))).collect();
            return to_value(CommandsListResult { commands });
        }
        if *DECK {
            let commands = deck_commands().into_iter().filter(|command| params.groups.as_ref().is_none_or(|groups| groups.contains(&command.group))).collect();
            return to_value(CommandsListResult { commands });
        }
        let slides = SLIDES.then(slide_commands).into_iter().flatten();
        let timeline = TIMELINE.then(timeline_commands).into_iter().flatten();
        let commands = commands
            .into_iter()
            .chain(slides)
            .chain(timeline)
            .filter(|command| params.groups.as_ref().is_none_or(|groups| groups.contains(&command.group)))
            .collect();
        to_value(CommandsListResult { commands })
    }

    fn execute(&self, params: CommandsExecuteParams, step: &mut Step) -> Handled {
        if params.command == "file.close" && std::env::var_os("KITION_KIT_MOCK_CLOSE").is_some() {
            if std::env::var("KITION_KIT_MOCK_CLOSE").as_deref() == Ok("cancel") {
                return to_value(CommandsExecuteResult { changed: false, result: Some(json!({"closed":false})) });
            }
            let mut state = self.state();
            let index =
                state.documents.iter().position(|document| document.id == params.document_id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
            state.documents.remove(index);
            return to_value(CommandsExecuteResult { changed: false, result: Some(json!({"closed":true})) });
        }
        if params.command == PROBE {
            return to_value(CommandsExecuteResult { changed: false, result: Some(probe()) });
        }
        if *TIMELINE && matches!(params.command.as_str(), "playhead.set" | "sequence.open" | RENDER) {
            return self.execute_on_timeline(&params);
        }
        if *TIMELINE && params.command == "sequence.append" {
            return self.append_to_sequence(&params, step);
        }
        if *DECK {
            return self.execute_on_deck(&params, step);
        }
        if *TRACKS {
            return self.execute_on_tracks(&params, step);
        }
        if *SLIDES
            && matches!(
                params.command.as_str(),
                "slide.go" | "slide.inspect" | "shape.text" | "shape.write" | "shape.upper" | "selection.set" | "format.mark" | "mode.set"
            )
        {
            return self.execute_on_slides(&params, step);
        }
        let allowed: &[&str] = match params.command.as_str() {
            "text.append" => &["text"],
            "text.insert" if std::env::var_os("KITION_KIT_MOCK_TEXT_INSERT").is_some() => &["at", "text"],
            "text.clear" => &[],
            "edit.undo" => &["scope"],
            _ => return Err(RpcError::kit(ErrorReason::CommandNotFound)),
        };
        let unknown: Vec<Value> = params
            .params
            .keys()
            .filter(|key| !allowed.contains(&key.as_str()))
            .map(|key| json!({ "path": format!("/{key}"), "message": format!("unknown parameter `{key}`"), "expected": format!("one of the parameters {}", allowed.join(", ")) }))
            .collect();
        if !unknown.is_empty() {
            return Err(invalid_command_params(unknown));
        }
        let appended = match params.command.as_str() {
            "text.append" | "text.insert" => match params.params.get("text").and_then(Value::as_str) {
                Some(text) if !text.is_empty() => Some(text.to_owned()),
                _ => {
                    return Err(invalid_command_params(vec![
                        json!({ "path": "/text", "message": "`text` must be a non-empty string", "expected": "a non-empty string" }),
                    ]));
                }
            },
            _ => None,
        };
        // A host's change (origin system) is no undo step; this kit keeps whole texts as its undo
        // steps, so the earlier steps go too, rather than an undo taking the host's change back.
        let system = params.origin == kition_kit_process_protocol::types::Origin::System;
        let state = self.with_document(&params.document_id, |document| {
            if document.read_only {
                return Err(RpcError::kit(ErrorReason::CommandDisabled));
            }
            if system && params.command == "edit.undo" {
                return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "the host does not undo the person's steps"));
            }
            match params.command.as_str() {
                "text.insert" => {
                    let at = params
                        .params
                        .get("at")
                        .and_then(Value::as_u64)
                        .and_then(|at| usize::try_from(at).ok())
                        .ok_or_else(|| RpcError::invalid_params("at must be a character index"))?;
                    let byte = document
                        .text
                        .char_indices()
                        .map(|(byte, _)| byte)
                        .chain([document.text.len()])
                        .nth(at)
                        .ok_or_else(|| RpcError::invalid_params("at is past the text"))?;
                    document.history.push(document.text.clone());
                    document.text.insert_str(byte, appended.as_deref().unwrap_or_default());
                }
                "text.append" => {
                    document.history.push(document.text.clone());
                    document.text.push_str(appended.as_deref().unwrap_or_default());
                }
                "text.clear" if !document.text.is_empty() => {
                    document.history.push(std::mem::take(&mut document.text));
                }
                "edit.undo" => match document.history.pop() {
                    Some(previous) => document.text = previous,
                    None => return Err(RpcError::kit(ErrorReason::CommandDisabled)),
                },
                _ => return Err(RpcError::kit(ErrorReason::CommandDisabled)),
            }
            if system {
                document.history.clear();
            }
            document.dirty = true;
            Ok(document.state())
        })?;
        self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        to_value(CommandsExecuteResult { changed: true, result: None })
    }

    /// The slide commands ([`SLIDES`]): `slide.go` (`index` counted from 0, or the slide's `id`)
    /// makes a slide current and answers its `index`; `slide.inspect` (`index`) lists a slide's
    /// objects; `shape.text` (`id`, `text`) sets the text of the object `id` of the current slide,
    /// so an id names another slide's object once another slide is current.
    fn execute_on_slides(&self, params: &CommandsExecuteParams, step: &mut Step) -> Handled {
        let given = &params.params;
        let index = given.get("index").and_then(Value::as_u64).map(|index| index as usize);
        let invalid = |path: &str, message: String| invalid_command_params(vec![json!({ "path": path, "message": message, "expected": "see slide.inspect" })]);
        let (changed, result, state) = self.with_document(&params.document_id, |document| {
            let mut slides = slides_of(&document.text);
            let count = slides.len();
            let past_end = |index: usize| invalid("/index", format!("slide index {index} is past the last slide (the document has {count}, counted from 0)"));
            match params.command.as_str() {
                "slide.go" => {
                    let index = match (index, given.get("id").and_then(Value::as_u64)) {
                        (Some(index), _) => index,
                        (None, Some(id)) => (0..count).find(|at| slide_id(*at) == id).ok_or_else(|| invalid("/id", format!("no slide has id {id}")))?,
                        (None, None) => return Err(invalid("", "`slide.go` takes `index` or `id`".to_owned())),
                    };
                    if index >= count {
                        return Err(past_end(index));
                    }
                    if document.current != index {
                        document.selection.clear();
                    }
                    document.current = index;
                    Ok((false, Some(json!({ "index": index })), None))
                }
                "slide.inspect" => {
                    let index = index.unwrap_or(document.current);
                    let objects = slides.get(index).ok_or_else(|| past_end(index))?;
                    let objects: Vec<Value> = objects.iter().enumerate().map(|(at, text)| json!({ "id": format!("s{}", at + 1), "text": text })).collect();
                    Ok((false, Some(json!({ "id": slide_id(index), "index": index, "shapes": objects })), None))
                }
                "mode.set" => {
                    let mode = given.get("mode").and_then(Value::as_str).filter(|mode| matches!(*mode, "normal" | "caps"));
                    document.mode = mode.ok_or_else(|| invalid("/mode", "`mode` is `normal` or `caps`".to_owned()))?.to_owned();
                    Ok((false, None, None))
                }
                "selection.set" => {
                    let ids = given.get("ids").and_then(Value::as_array).ok_or_else(|| invalid("/ids", "`ids` is a list of object ids".to_owned()))?;
                    let ids: Vec<Value> = ids.clone();
                    document.selection = objects_of(&slides, document.current.min(count - 1), &ids)
                        .map_err(|message| invalid("/ids", message))?
                        .into_iter()
                        .map(|at| format!("s{}", at + 1))
                        .collect();
                    Ok((false, None, None))
                }
                command => {
                    if document.read_only {
                        return Err(RpcError::kit(ErrorReason::CommandDisabled));
                    }
                    let current = document.current.min(count - 1);
                    let (targets, path): (Vec<Value>, &str) = match command {
                        "shape.text" | "shape.write" => (vec![given.get("id").cloned().unwrap_or(json!(""))], "/id"),
                        "shape.upper" => (given.get("ids").and_then(Value::as_array).cloned().unwrap_or_default(), "/ids"),
                        _ if document.selection.is_empty() => {
                            return Err(invalid("", "`format.mark` marks the selected objects, and nothing is selected".to_owned()));
                        }
                        _ => (document.selection.iter().map(|id| json!(id)).collect(), ""),
                    };
                    let at = objects_of(&slides, current, &targets).map_err(|message| invalid(path, message))?;
                    let text = match command {
                        "shape.text" | "shape.write" => {
                            let text = given.get("text").and_then(Value::as_str).ok_or_else(|| invalid("/text", "`text` is a string".to_owned()))?;
                            Some(if command == "shape.write" && document.mode == "caps" { text.to_uppercase() } else { text.to_owned() })
                        }
                        _ => None,
                    };
                    for index in at {
                        let object = &mut slides[current][index];
                        *object = match (command, &text) {
                            (_, Some(text)) => text.clone(),
                            ("shape.upper", _) => object.to_uppercase(),
                            _ => format!("*{object}*"),
                        };
                    }
                    document.history.push(std::mem::replace(&mut document.text, slides_text(&slides)));
                    document.dirty = true;
                    Ok((true, None, Some(document.state())))
                }
            }
        })?;
        if let Some(state) = state {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
        to_value(CommandsExecuteResult { changed, result })
    }

    /// The commands of a deck ([`DECK`]): `slide.go` and `slide.inspect` as with slides, and the
    /// deck's editing commands ([`deck::edit`]) on its object model, run as the request's origin.
    fn execute_on_deck(&self, params: &CommandsExecuteParams, step: &mut Step) -> Handled {
        let given = &params.params;
        let invalid = |path: &str, message: String| invalid_command_params(vec![json!({ "path": path, "message": message, "expected": "see slide.inspect" })]);
        let origin = match params.origin {
            kition_kit_process_protocol::types::Origin::User => Origin::person("person:local"),
            kition_kit_process_protocol::types::Origin::Agent => Origin::agent("person:local"),
            kition_kit_process_protocol::types::Origin::System => Origin::system("host"),
        };
        let (changed, result, state) = self.with_document(&params.document_id, |document| {
            document.model()?;
            let replica = document.model.as_mut().ok_or_else(|| RpcError::internal("no model"))?;
            let count = deck::count(replica);
            match params.command.as_str() {
                "slide.go" => {
                    let index = match (given.get("index").and_then(Value::as_u64), given.get("id").and_then(Value::as_u64)) {
                        (Some(index), _) => index as usize,
                        (None, Some(id)) => deck::slide_index(replica, id).ok_or_else(|| invalid("/id", format!("no slide has id {id}")))?,
                        (None, None) => return Err(invalid("", "`slide.go` takes `index` or `id`".to_owned())),
                    };
                    if index >= count {
                        return Err(invalid("/index", format!("slide index {index} is past the last slide (the deck has {count}, counted from 0)")));
                    }
                    if document.current != index {
                        document.selection.clear();
                    }
                    document.current = index;
                    Ok((false, Some(json!({ "index": index })), None))
                }
                "slide.inspect" => {
                    let index = given.get("index").and_then(Value::as_u64).map_or(document.current, |index| index as usize);
                    Ok((false, Some(deck::inspect(replica, index).map_err(|message| invalid("/index", message))?), None))
                }
                command => {
                    if document.read_only {
                        return Err(RpcError::kit(ErrorReason::CommandDisabled));
                    }
                    let result = deck::edit(replica, command, given, &origin).map_err(|message| invalid("", message))?;
                    let text = deck::text_of(replica);
                    document.history.push(std::mem::replace(&mut document.text, text));
                    document.current = document.current.min(deck::count(replica).saturating_sub(1));
                    document.dirty = true;
                    Ok((true, result, Some(document.state())))
                }
            }
        })?;
        if let Some(state) = state {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
        to_value(CommandsExecuteResult { changed, result })
    }

    /// The commands of a timeline of clips ([`TRACKS`], [`tracks::edit`]) on its object model, run
    /// as the request's origin with the editor's playhead and selection; `timeline.selectAt` sets
    /// the selection and is no edit.
    fn execute_on_tracks(&self, params: &CommandsExecuteParams, step: &mut Step) -> Handled {
        let origin = match params.origin {
            kition_kit_process_protocol::types::Origin::User => Origin::person("person:local"),
            kition_kit_process_protocol::types::Origin::Agent => Origin::agent("person:local"),
            kition_kit_process_protocol::types::Origin::System => Origin::system("host"),
        };
        let invalid = |message: String| invalid_command_params(vec![json!({ "path": "", "message": message, "expected": "see the command's parameters" })]);
        let (changed, result, state) = self.with_document(&params.document_id, |document| {
            document.model()?;
            let (playhead, selection, current) = (document.playhead, document.selection.clone(), document.current);
            let replica = document.model.as_mut().ok_or_else(|| RpcError::internal("no model"))?;
            if document.read_only && !matches!(params.command.as_str(), "timeline.selectAt" | "playhead.set") {
                return Err(RpcError::kit(ErrorReason::CommandDisabled));
            }
            let edited = tracks::edit(replica, &params.command, &params.params, &origin, playhead, &selection, current).map_err(invalid)?;
            if params.command == "playhead.set" {
                document.playhead = params
                    .params
                    .get("time")
                    .and_then(Value::as_f64)
                    .filter(|time| *time >= 0.0)
                    .ok_or_else(|| invalid("`time` is a number of seconds".to_owned()))?;
            }
            if let Some(selection) = edited.selection {
                document.selection = selection;
            }
            if !edited.changed {
                return Ok((false, edited.result, None));
            }
            let text = tracks::text_of(replica);
            document.history.push(std::mem::replace(&mut document.text, text));
            document.dirty = true;
            Ok((true, edited.result, Some(document.state())))
        })?;
        if let Some(state) = state {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
        to_value(CommandsExecuteResult { changed, result })
    }

    /// `sequence.append` ([`TIMELINE`]): appends `text` to the open sequence's line, an edit.
    fn append_to_sequence(&self, params: &CommandsExecuteParams, step: &mut Step) -> Handled {
        let text = params.params.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()).ok_or_else(|| {
            invalid_command_params(vec![json!({ "path": "/text", "message": "`text` must be a non-empty string", "expected": "a non-empty string" })])
        })?;
        let state = self.with_document(&params.document_id, |document| {
            if document.read_only {
                return Err(RpcError::kit(ErrorReason::CommandDisabled));
            }
            let mut sequences = slides_of(&document.text);
            let open = document.current.min(sequences.len() - 1);
            if let Some(last) = sequences[open].last_mut() {
                last.push_str(text);
            }
            document.history.push(std::mem::replace(&mut document.text, slides_text(&sequences)));
            document.dirty = true;
            Ok(document.state())
        })?;
        self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        to_value(CommandsExecuteResult { changed: true, result: None })
    }

    /// The timeline commands ([`TIMELINE`]): `playhead.set` (`time` in seconds) and `sequence.open`
    /// (`sequence`, counted from 1) move the editor's state, and [`RENDER`] draws an explicit view
    /// ([`render_view`]). None of them is an edit.
    fn execute_on_timeline(&self, params: &CommandsExecuteParams) -> Handled {
        let given = &params.params;
        let invalid =
            |path: &str, message: String, expected: &str| invalid_command_params(vec![json!({ "path": path, "message": message, "expected": expected })]);
        let result = self.with_document(&params.document_id, |document| {
            let count = slides_of(&document.text).len();
            match params.command.as_str() {
                "playhead.set" => {
                    let time = given
                        .get("time")
                        .and_then(Value::as_f64)
                        .filter(|time| (0.0..SEQUENCE_SECONDS).contains(time))
                        .ok_or_else(|| invalid("/time", format!("`time` is seconds from 0 to before {SEQUENCE_SECONDS}"), "a number"))?;
                    document.playhead = time;
                    Ok(None)
                }
                "sequence.open" => {
                    let sequence = given
                        .get("sequence")
                        .and_then(Value::as_u64)
                        .filter(|sequence| (1..=count as u64).contains(sequence))
                        .ok_or_else(|| invalid("/sequence", format!("`sequence` is counted from 1 (the document has {count})"), "a whole number"))?;
                    document.current = sequence as usize - 1;
                    Ok(None)
                }
                _ => render_view(&document.text, given).map(Some),
            }
        })?;
        to_value(CommandsExecuteResult { changed: false, result })
    }

    /// The Kit Process Protocol's editor context (section 7a): `context.get` answers the current slide
    /// and the selection (`null` for documents without slides), `context.set` sets them from a
    /// call's `part` (`{slide}` counted from 1, or `{slideId}`) and `on` (ids of that slide), and
    /// `context.restore` puts back what `context.get` answered. None of them is an edit.
    fn context(&self, method: &str, params: &Value) -> Handled {
        if *crate::matrix::MATRIX
            && let Ok(path) = std::env::var("KITION_KIT_MOCK_EDITOR_FILE")
        {
            if method == "context.get" {
                let state: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| RpcError::internal(e.to_string()))?)
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                return Ok(json!({"state":state}));
            }
            if method == "context.restore" {
                return Ok(json!({}));
            }
        }
        let id = document_param(params)?;
        self.with_document(&id, |document| match method {
            "context.get" if *TIMELINE => Ok(json!({ "state": { "sequence": document.current, "playhead": document.playhead } })),
            "context.restore" if *TIMELINE => {
                let state = &params["state"];
                if state.is_null() {
                    return Ok(json!({}));
                }
                let (Some(sequence), Some(playhead)) = (state["sequence"].as_u64(), state["playhead"].as_f64()) else {
                    return Err(RpcError::invalid_params("`state` is what context.get answered"));
                };
                document.current = sequence as usize;
                document.playhead = playhead;
                Ok(json!({}))
            }
            "context.set" if *TIMELINE => {
                if !params["on"].is_null() {
                    return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "setting `on` is not available in this kit"));
                }
                // The part is the kit's own noun ([`PART_NOUN`]), `{sequence}` counted from 1, as
                // its manifest declares it (`agent.parts`) and the host passes it unchanged.
                if let Some(part) = params.get("part").filter(|part| !part.is_null()) {
                    let count = slides_of(&document.text).len() as u64;
                    let noun = PART_NOUN.as_str();
                    let first = u64::from(noun == "sequence");
                    let sequence = part
                        .as_object()
                        .filter(|part| part.len() == 1)
                        .and_then(|part| part.get(noun))
                        .and_then(Value::as_u64)
                        .filter(|sequence| (first..count + first).contains(sequence))
                        .ok_or_else(|| {
                            RpcError::invalid_params(format!("`part` {part} is not {{\"{noun}\": n}} with n from {first} to {}", count + first - 1))
                        })?;
                    document.current = (sequence - first) as usize;
                }
                if let Some(time) = params.get("time").filter(|time| !time.is_null()) {
                    document.playhead = time.as_f64().filter(|time| (0.0..SEQUENCE_SECONDS).contains(time)).ok_or_else(|| {
                        RpcError::invalid_params(format!("`time` {time} is not within the sequence (0 to before {SEQUENCE_SECONDS} seconds)"))
                    })?;
                }
                Ok(json!({}))
            }
            "context.get" | "context.set" | "context.restore" if *DECK => deck_context(document, method, params),
            _ if *TRACKS => tracks_context(document, method, params),
            "context.get" if *SLIDES => Ok(json!({ "state": { "slide": document.current, "selection": document.selection, "mode": document.mode } })),
            "context.get" => Ok(json!({ "state": null })),
            "context.restore" => {
                let state = &params["state"];
                if state.is_null() {
                    return Ok(json!({}));
                }
                let slide = state["slide"].as_u64().filter(|_| *SLIDES).ok_or_else(|| RpcError::invalid_params("`state` is what context.get answered"))?;
                document.current = slide as usize;
                document.selection = state["selection"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                document.mode = state["mode"].as_str().unwrap_or("normal").to_owned();
                Ok(json!({}))
            }
            _ => {
                let given: Vec<&str> = ["on", "part", "time"].into_iter().filter(|key| !params[*key].is_null()).collect();
                if (!*SLIDES && !given.is_empty()) || !params["time"].is_null() {
                    let named = given.iter().map(|key| format!("`{key}`")).collect::<Vec<_>>().join(", ");
                    return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, format!("setting {named} is not available in this kit")));
                }
                let slides = slides_of(&document.text);
                let count = slides.len();
                if let Some(part) = params.get("part").filter(|part| !part.is_null()) {
                    let index = match (part.get("slide").and_then(Value::as_u64), part.get("slideId").and_then(Value::as_u64)) {
                        (Some(slide), _) if slide >= 1 && (slide as usize) <= count => slide as usize - 1,
                        (Some(slide), _) => {
                            return Err(RpcError::invalid_params(format!("slide {slide} is not a slide of this document (it has {count}, counted from 1)")));
                        }
                        (None, Some(id)) => {
                            (0..count).find(|at| slide_id(*at) == id).ok_or_else(|| RpcError::invalid_params(format!("no slide has id {id}")))?
                        }
                        (None, None) => return Err(RpcError::invalid_params(format!("`part` {part} names no slide: give `slide` or `slideId`"))),
                    };
                    if document.current != index {
                        document.selection.clear();
                    }
                    document.current = index;
                }
                if let Some(on) = params.get("on").and_then(Value::as_array).filter(|on| !on.is_empty()) {
                    let current = document.current.min(count - 1);
                    let at = objects_of(&slides, current, on).map_err(RpcError::invalid_params)?;
                    document.selection = at.into_iter().map(|index| format!("s{}", index + 1)).collect();
                }
                Ok(json!({}))
            }
        })
    }

    fn history_blob(&self, params: &Value, hash: &str, offset: usize, length: usize) -> Handled {
        if params["history"].is_object() {
            let Ok(bytes) = serde_json::from_value::<Vec<u8>>(params["history"][hash].clone()) else {
                return Ok(json!({"available":false}));
            };
            if offset > bytes.len() || length > 1024 * 1024 {
                return Ok(json!({"available":false}));
            }
            return Ok(json!({"available":true,"size":bytes.len(),"data":base64::encode(&bytes[offset..offset.saturating_add(length).min(bytes.len())])}));
        }
        self.ask::<methods::HistoryBlobRead>(&HistoryBlobReadParams {
            token: params["history"].as_str().unwrap_or_default().to_owned(),
            hash: hash.to_owned(),
            offset,
            length,
        })
    }

    fn premise_plan(&self, params: &Value) -> Handled {
        let id = document_param(params)?;
        match params["action"].as_str() {
            Some(action @ ("begin" | "advance")) => {
                let steps = params["steps"].as_array().ok_or_else(|| RpcError::invalid_params("steps required"))?;
                let count = steps.len() + params["ops"].as_array().map_or(0, Vec::len);
                let size = params.to_string().len();
                if count > 256 || size > 1024 * 1024 || action == "begin" && self.state().plans.len() >= 16 {
                    return Err(RpcError::invalid_params("plan limit"));
                }
                let (token, before, before_state, mut refs, operations, bytes) = if action == "advance" {
                    let token = params["token"].as_str().unwrap_or_default();
                    let plan =
                        self.state().plans.remove(token).filter(|plan| plan.document == id).ok_or_else(|| RpcError::invalid_params("plan unavailable"))?;
                    (
                        token.to_owned(),
                        plan.before,
                        plan.info["beforeState"].clone(),
                        plan.info["refs"].as_object().cloned().unwrap_or_default(),
                        plan.operations + count,
                        plan.bytes + size,
                    )
                } else {
                    let (mut scratch, before) = self.with_document(&id, |source| {
                        let replica = source.model()?;
                        let before = replica.version();
                        let model = Replica::load(
                            Arc::new(replica.schema().clone()),
                            &replica.snapshot().map_err(|error| RpcError::internal(error.to_string()))?,
                            ActorId::random(),
                        )
                        .map_err(|error| RpcError::internal(error.to_string()))?;
                        Ok((
                            Document {
                                id: String::new(),
                                file: source.file.clone(),
                                name: source.name.clone(),
                                version: source.version.clone(),
                                conflict: false,
                                text: source.text.clone(),
                                history: Vec::new(),
                                dirty: true,
                                read_only: false,
                                model: Some(model),
                                current: source.current,
                                selection: source.selection.clone(),
                                playhead: source.playhead,
                                mode: source.mode.clone(),
                            },
                            before,
                        ))
                    })?;
                    let before_state = self.context("context.get", &json!({"documentId":id}))?["state"].clone();
                    let token = {
                        let mut state = self.state();
                        state.next_document += 1;
                        let token = format!("plan-{}", state.next_document);
                        scratch.id = token.clone();
                        state.documents.push(scratch);
                        token
                    };
                    (token, before, before_state, Map::new(), count, size)
                };
                let result = (|| {
                    if operations > 256 || bytes > 1024 * 1024 {
                        return Err(RpcError::invalid_params("plan limit"));
                    }
                    if let Some(ops) = params.get("ops") {
                        if ops.as_array().into_iter().flatten().any(|op| op["ref"].as_str().is_some_and(|name| refs.contains_key(name))) {
                            return Err(RpcError::invalid_params("plan reference already bound"));
                        }
                        let bound = refs.iter().filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), ObjectId::from_string(value)))).collect();
                        let ops = batch::resolve_values(ops, &bound);
                        let answer = self.dispatch(
                            Role::Agent,
                            "model.batch",
                            json!({"documentId":token,"ops":ops,"origin":{"kind":"agent","principal":"premise-plan"}}),
                            &mut Step::default(),
                        )?;
                        refs.extend(answer["refs"].as_object().into_iter().flatten().map(|(key, value)| (key.clone(), value.clone())));
                    }
                    for step in steps {
                        if let Some(context) = step.get("context") {
                            let mut context = context.as_object().cloned().unwrap_or_default();
                            context.insert("documentId".into(), json!(token));
                            self.context("context.set", &json!(context))?;
                        }
                        let answer = self.dispatch(
                            Role::Agent,
                            "commands.execute",
                            json!({"documentId":token,"command":step["command"],"params":step.get("params").cloned().unwrap_or(json!({})),"origin":"agent"}),
                            &mut Step::default(),
                        )?;
                        if answer["result"]["closed"] == true {
                            return Ok(json!({"closed":true}));
                        }
                    }
                    self.with_document(&token, |scratch| {
                        let replica = scratch.model()?;
                        let changes = replica.changes_since(&before).map_err(|error| RpcError::internal(error.to_string()))?.to_recorded_json(replica.schema());
                        Ok(json!({"token":token,"changes":changes,"beforeState":before_state,"step":params["step"],"refs":refs}))
                    })
                })();
                match result {
                    Ok(info) if info["closed"] == true => Ok(info),
                    Ok(mut info) => {
                        info["state"] = self.context("context.get", &json!({"documentId":token}))?["state"].clone();
                        self.state().plans.insert(token, PremisePlan { document: id, info: info.clone(), before, operations, bytes });
                        Ok(info)
                    }
                    Err(error) => {
                        self.state().documents.retain(|doc| doc.id != token);
                        Err(error)
                    }
                }
            }
            Some("end") => {
                let token = params["token"].as_str().unwrap_or_default();
                let mut state = self.state();
                state.plans.remove(token);
                state.documents.retain(|doc| doc.id != token);
                Ok(json!({}))
            }
            Some("read") => {
                let token = params["token"].as_str().unwrap_or_default();
                let info = self
                    .state()
                    .plans
                    .get(token)
                    .filter(|plan| plan.document == id)
                    .map(|plan| plan.info.clone())
                    .ok_or_else(|| RpcError::invalid_params("plan unavailable"))?;
                let method = params["method"].as_str().unwrap_or_default();
                if !matches!(method, "under" | "covered" | "content" | "state" | "identity" | "model.batch" | "model.describe" | "model.derived") {
                    return Err(RpcError::invalid_params("not a plan read"));
                }
                let mut given = params["params"].as_object().cloned().unwrap_or_default();
                if method == "model.batch" && given.get("ops").and_then(Value::as_array).is_none_or(|ops| !ops.is_empty()) {
                    return Err(RpcError::invalid_params("plan is read only"));
                }
                given.insert("documentId".into(), json!(token));
                if !method.starts_with("model.") {
                    for key in ["step", "state", "changes"] {
                        given.insert(key.into(), info[key].clone());
                    }
                }
                if method == "state" {
                    return Ok(json!({"state":info["state"],"beforeState":info["beforeState"]}));
                }
                let method = if method.starts_with("model.") { method.to_owned() } else { format!("context.{method}") };
                self.dispatch(Role::Agent, &method, json!(given), &mut Step::default())
            }
            _ => Err(RpcError::invalid_params("plan action required")),
        }
    }

    fn with_document<T>(&self, id: &str, action: impl FnOnce(&mut Document) -> Result<T, RpcError>) -> Result<T, RpcError> {
        let mut state = self.state();
        let document = state.documents.iter_mut().find(|document| document.id == id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        action(document)
    }

    fn broadcast<N: NotificationMethod>(&self, params: &N::Params, step: &mut Step) {
        let Ok(params) = serde_json::to_value(params) else {
            return;
        };
        let notification = Notification::new(N::NAME, Some(params)).to_value();
        for writer in self.state().clients.values() {
            step.broadcast.push((Arc::clone(writer), notification.clone()));
        }
    }
}

/// The editor context of a deck ([`DECK`]): the current slide (`part`, `{slide}` counted from 1
/// or `{slideId}`) and the selected shapes (`on`, by tool id).
fn deck_context(document: &mut Document, method: &str, params: &Value) -> Handled {
    match method {
        "context.get" => Ok(json!({ "state": { "slide": document.current, "selection": document.selection } })),
        "context.restore" => {
            let state = &params["state"];
            if state.is_null() {
                return Ok(json!({}));
            }
            document.current = state["slide"].as_u64().ok_or_else(|| RpcError::invalid_params("`state` is what context.get answered"))? as usize;
            document.selection = state["selection"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            Ok(json!({}))
        }
        _ => {
            if !params["time"].is_null() {
                return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "setting `time` is not available in this kit"));
            }
            document.model()?;
            let replica = document.model.as_ref().ok_or_else(|| RpcError::internal("no model"))?;
            let count = deck::count(replica);
            let mut current = document.current;
            if let Some(part) = params.get("part").filter(|part| !part.is_null()) {
                current = match (part.get("slide").and_then(Value::as_u64), part.get("slideId").and_then(Value::as_u64)) {
                    (Some(slide), _) if slide >= 1 && (slide as usize) <= count => slide as usize - 1,
                    (Some(slide), _) => {
                        return Err(RpcError::invalid_params(format!("slide {slide} is not a slide of this deck (it has {count}, counted from 1)")));
                    }
                    (None, Some(id)) => deck::slide_index(replica, id).ok_or_else(|| RpcError::invalid_params(format!("no slide has id {id}")))?,
                    (None, None) => return Err(RpcError::invalid_params(format!("`part` {part} names no slide: give `slide` or `slideId`"))),
                };
            }
            let mut selection = None;
            if let Some(on) = params.get("on").and_then(Value::as_array).filter(|on| !on.is_empty()) {
                let ids: Vec<String> = on.iter().map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned)).collect();
                if let Some(missing) = ids.iter().find(|id| !deck::has_shape(replica, id)) {
                    return Err(RpcError::invalid_params(format!("no shape `{missing}` in the deck")));
                }
                selection = Some(ids);
            }
            if current != document.current {
                document.selection.clear();
            }
            document.current = current;
            if let Some(selection) = selection {
                document.selection = selection;
            }
            Ok(json!({}))
        }
    }
}

/// The editor context of a timeline of clips ([`TRACKS`]): the playhead (`time`, seconds), the
/// selected clips (`on`, by number) and the current track (`part`, `{ "track": name }`); and
/// `context.under`, what a place-addressed command names at a call's `time` and part
/// ([`tracks::under`]), which changes nothing.
fn tracks_context(document: &mut Document, method: &str, params: &Value) -> Handled {
    let track_of = |document: &mut Document, part: &Value| -> Result<usize, RpcError> {
        let name = part
            .get("track")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params(format!("{part} names no track: a part is `{{\"track\": name}}`")))?;
        document.model()?;
        let replica = document.model.as_ref().ok_or_else(|| RpcError::internal("no model"))?;
        tracks::track_index(replica, name).ok_or_else(|| RpcError::invalid_params(format!("no track `{name}` in the timeline")))
    };
    match method {
        "context.get" => Ok(json!({ "state": { "playhead": document.playhead, "selection": document.selection, "track": document.current } })),
        "context.restore" => {
            let state = &params["state"];
            if state.is_null() {
                return Ok(json!({}));
            }
            document.current = state["track"].as_u64().and_then(|track| usize::try_from(track).ok()).unwrap_or(0);
            document.playhead = state["playhead"].as_f64().ok_or_else(|| RpcError::invalid_params("`state` is what context.get answered"))?;
            document.selection = state["selection"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            Ok(json!({}))
        }
        "context.under" => {
            let command = params["command"].as_str().ok_or_else(|| RpcError::invalid_params("`command` names the command"))?;
            let given = params["params"].as_object().cloned().unwrap_or_default();
            let time = params["time"].as_f64().or(Some(document.playhead));
            let current = match params.get("part").filter(|part| !part.is_null()) {
                Some(part) => track_of(document, part)?,
                None => document.current,
            };
            document.model()?;
            let replica = document.model.as_ref().ok_or_else(|| RpcError::internal("no model"))?;
            if command == "clip.disable" {
                let selection = params
                    .get("on")
                    .and_then(Value::as_array)
                    .cloned()
                    .or_else(|| given.get("clips").and_then(Value::as_array).cloned())
                    .unwrap_or_else(|| document.selection.iter().map(|id| json!(id)).collect());
                return Ok(
                    json!({"objects":selection,"premises":selection.iter().map(|id|json!({"id":id,"fields":["enabled"],"positions":[]})).collect::<Vec<_>>()}),
                );
            }
            match tracks::under(replica, command, &given, time, current).map_err(RpcError::invalid_params)? {
                Some(under) => Ok(under),
                None => Ok(Value::Null),
            }
        }
        _ => {
            let current = match params.get("part").filter(|part| !part.is_null()) {
                Some(part) => Some(track_of(document, part)?),
                None => None,
            };
            document.model()?;
            let replica = document.model.as_ref().ok_or_else(|| RpcError::internal("no model"))?;
            let mut selection = None;
            if let Some(on) = params.get("on").and_then(Value::as_array).filter(|on| !on.is_empty()) {
                if let Some(missing) = on.iter().find(|id| !tracks::has_clip(replica, id)) {
                    return Err(RpcError::invalid_params(format!("no clip {missing} in the timeline")));
                }
                selection = Some(on.iter().map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned)).collect());
            }
            if let Some(time) = params.get("time").filter(|time| !time.is_null()) {
                document.playhead = time.as_f64().filter(|time| *time >= 0.0).ok_or_else(|| RpcError::invalid_params(format!("`time` {time} is no time")))?;
            }
            if let Some(selection) = selection {
                document.selection = selection;
            }
            if let Some(current) = current {
                document.current = current;
            }
            Ok(json!({}))
        }
    }
}

/// The commands a timeline of clips offers ([`TRACKS`]).
fn tracks_commands() -> Vec<CommandInfo> {
    let mut commands: Vec<CommandInfo> = tracks::commands()
        .into_iter()
        .map(|(id, description, mutates, params)| CommandInfo {
            keywords: Vec::new(),
            id: id.to_owned(),
            title: id.to_owned(),
            description: Some(description.to_owned()),
            group: "timeline".to_owned(),
            params,
            output: None,
            mutates,
            enabled: true,
            menu: Vec::new(),
            shortcut: None,
        })
        .collect();
    commands.push(CommandInfo {
        keywords: Vec::new(),
        id: "edit.undo".to_owned(),
        title: "Undo".to_owned(),
        description: None,
        group: "edit".to_owned(),
        params: json!({ "type": "object", "additionalProperties": false, "properties": { "scope": { "enum": ["person", "agent"] } } }),
        output: None,
        mutates: true,
        enabled: true,
        menu: Vec::new(),
        shortcut: None,
    });
    commands
}

/// The commands a deck offers ([`DECK`]).
fn deck_commands() -> Vec<CommandInfo> {
    let mut commands: Vec<CommandInfo> = slide_commands().into_iter().filter(|command| matches!(command.id.as_str(), "slide.go" | "slide.inspect")).collect();
    for (id, description, params) in deck::commands() {
        commands.push(CommandInfo {
            keywords: Vec::new(),
            id: id.to_owned(),
            title: id.to_owned(),
            description: Some(description.to_owned()),
            group: "slide".to_owned(),
            params,
            output: None,
            mutates: true,
            enabled: true,
            menu: Vec::new(),
            shortcut: None,
        });
    }
    commands.push(CommandInfo {
        keywords: Vec::new(),
        id: "edit.undo".to_owned(),
        title: "Undo".to_owned(),
        description: None,
        group: "edit".to_owned(),
        params: json!({ "type": "object", "additionalProperties": false, "properties": { "scope": { "enum": ["person", "agent"] } } }),
        output: None,
        mutates: true,
        enabled: true,
        menu: Vec::new(),
        shortcut: None,
    });
    let mut redo = commands.last().expect("undo command").clone();
    redo.id = "edit.redo".to_owned();
    redo.title = "Redo".to_owned();
    commands.push(redo);
    commands
}

/// The positions on slide `current` of the objects `ids` names, or a message naming the first
/// id that slide lacks.
fn objects_of(slides: &[Vec<String>], current: usize, ids: &[Value]) -> Result<Vec<usize>, String> {
    let objects = slides.get(current).map_or(0, Vec::len);
    let listed = (1..=objects).map(|at| format!("s{at}")).collect::<Vec<_>>().join(", ");
    ids.iter()
        .map(|id| {
            let id = id.as_str().unwrap_or_default();
            id.strip_prefix('s')
                .and_then(|number| number.parse::<usize>().ok())
                .and_then(|number| number.checked_sub(1))
                .filter(|at| *at < objects)
                .ok_or_else(|| format!("no object `{id}` on slide {} (counted from 1); its objects are {listed}", current + 1))
        })
        .collect()
}

/// The commands documents with slides offer ([`SLIDES`]). Their parameter schemas say what each
/// acts on (`x-khp-role: targets`) and the editor state it reads (`x-khp-reads`, Kit Process Protocol
/// section 6).
fn slide_commands() -> Vec<CommandInfo> {
    let command = |id: &str, title: &str, description: &str, params: Value, mutates: bool| CommandInfo {
        keywords: Vec::new(),
        id: id.to_owned(),
        title: title.to_owned(),
        description: Some(description.to_owned()),
        group: "slide".to_owned(),
        params,
        output: None,
        mutates,
        enabled: true,
        menu: Vec::new(),
        shortcut: None,
    };
    vec![
        command(
            "slide.go",
            "Go to slide",
            "Makes a slide current, by `index` (counted from 0) or `id`; answers its `index`.",
            json!({ "type": "object", "additionalProperties": false, "properties": { "index": { "type": "integer", "minimum": 0 }, "id": { "type": "integer" } } }),
            false,
        ),
        command(
            "slide.inspect",
            "Inspect slide",
            "Lists the objects of a slide (`shapes`, `index` counted from 0), with their ids.",
            json!({ "type": "object", "additionalProperties": false, "properties": { "index": { "type": "integer", "minimum": 0 } } }),
            false,
        ),
        command(
            "shape.text",
            "Set object text",
            "Sets the text of an object of the current slide by its `id`.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "text"],
                "x-khp-reads": ["part"],
                "properties": { "id": { "type": "string", "x-khp-role": "targets" }, "text": { "type": "string" } }
            }),
            true,
        ),
        command(
            "shape.write",
            "Write object text",
            "Writes text into an object of the current slide by its `id`, in the editor's mode: upper case in `caps` mode.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "text"],
                "x-khp-reads": ["part", "mode"],
                "properties": { "id": { "type": "string", "x-khp-role": "targets" }, "text": { "type": "string" } }
            }),
            true,
        ),
        command(
            "mode.set",
            "Set mode",
            "Sets the editor's mode (`normal` or `caps`), as a person switching modes does; not an edit.",
            json!({ "type": "object", "additionalProperties": false, "required": ["mode"], "properties": { "mode": { "enum": ["normal", "caps"] } } }),
            false,
        ),
        command(
            "shape.upper",
            "Upper-case objects",
            "Upper-cases the text of objects of the current slide, by their `ids`.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["ids"],
                "x-khp-reads": ["part"],
                "properties": { "ids": { "type": "array", "items": { "type": "string" }, "x-khp-role": "targets" } }
            }),
            true,
        ),
        command(
            "selection.set",
            "Select objects",
            "Selects objects of the current slide by their `ids`, as a person clicking them does.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["ids"],
                "x-khp-reads": ["part"],
                "properties": { "ids": { "type": "array", "items": { "type": "string" } } }
            }),
            false,
        ),
        command(
            "format.mark",
            "Mark selection",
            "Marks the selected objects of the current slide (their text between `*`); it takes no ids.",
            json!({ "type": "object", "additionalProperties": false, "x-khp-reads": ["selection", "part"] }),
            true,
        ),
    ]
}

/// The commands documents with a timeline offer ([`TIMELINE`]), the render command among them.
fn timeline_commands() -> Vec<CommandInfo> {
    let command = |id: &str, title: &str, description: &str, params: Value, output: Option<Value>| CommandInfo {
        keywords: Vec::new(),
        id: id.to_owned(),
        title: title.to_owned(),
        description: Some(description.to_owned()),
        group: "timeline".to_owned(),
        params,
        output,
        mutates: false,
        enabled: true,
        menu: Vec::new(),
        shortcut: None,
    };
    let append = CommandInfo {
        mutates: true,
        ..command(
            "sequence.append",
            "Append to sequence",
            "Appends `text` to the open sequence (its line), so it reads the editor's part: a call gives the sequence as its `target` or a step's `at.part`.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["text"],
                "x-khp-reads": ["part"],
                "properties": { "text": { "type": "string", "minLength": 1 } }
            }),
            None,
        )
    };
    vec![
        append,
        command(
            "playhead.set",
            "Move playhead",
            "Moves the playhead of the open sequence to `time` (seconds), as a person scrubbing does.",
            json!({ "type": "object", "additionalProperties": false, "required": ["time"], "properties": { "time": { "type": "number", "minimum": 0 } } }),
            None,
        ),
        command(
            "sequence.open",
            "Open sequence",
            "Opens a sequence (`sequence`, counted from 1) in the editor.",
            json!({ "type": "object", "additionalProperties": false, "required": ["sequence"], "properties": { "sequence": { "type": "integer", "minimum": 1 } } }),
            None,
        ),
        command(
            RENDER,
            "Render preview",
            "Draws a sequence at an explicit view as a PNG, never the playhead or the open sequence: `target.time` one frame, `target.range` [from, to] with `target.frames` (2 to 12, default 6) a contact sheet, neither a contact sheet of the whole sequence; `target.sequence` (counted from 1, default 1).",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "target": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "time": { "type": "number", "minimum": 0 },
                            "range": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
                            "frames": { "type": "integer", "minimum": 2, "maximum": 12 },
                            "sequence": { "type": "integer", "minimum": 1 }
                        }
                    },
                    "scale": { "type": "number", "exclusiveMinimum": 0, "maximum": 2 },
                    "maxSize": { "type": "integer", "minimum": 16, "maximum": 4096 }
                }
            }),
            Some(json!({
                "type": "object",
                "properties": {
                    "png": { "type": "string" }, "mimeType": { "type": "string" }, "width": { "type": "integer" }, "height": { "type": "integer" },
                    "scale": { "type": "number" }, "sequence": { "type": "integer" }, "frames": { "type": "array" }, "columns": { "type": "integer" }, "rows": { "type": "integer" }
                }
            })),
        ),
    ]
}

/// [`RENDER`] of `text`'s sequences: the frames the explicit view names, laid out four to a row,
/// each [`FRAME`] at the scale (brought down to fit `maxSize`). The PNG is blank, and carries the
/// view it shows (`tEXt` `view`: the sequence, the frames' times and the sequence's text), so the
/// same view of the same document answers the same bytes and any other view other bytes.
fn render_view(text: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
    let invalid = |path: &str, message: String| invalid_command_params(vec![json!({ "path": path, "message": message, "expected": "see file.render" })]);
    if let Some(other) = params.keys().find(|key| !["target", "scale", "maxSize"].contains(&key.as_str())) {
        return Err(invalid(&format!("/{other}"), format!("unknown parameter `{other}`")));
    }
    let empty = Map::new();
    let target = match params.get("target") {
        None => &empty,
        Some(Value::Object(target)) => target,
        Some(other) => return Err(invalid("/target", format!("`target` is {other}: an object"))),
    };
    if let Some(other) = target.keys().find(|key| !["time", "range", "frames", "sequence"].contains(&key.as_str())) {
        return Err(invalid(&format!("/target/{other}"), format!("unknown view member `{other}`: the view is `time`, `range`, `frames`, `sequence`")));
    }
    let sequences = slides_of(text);
    let sequence = match target.get("sequence") {
        None => 1,
        Some(value) => value.as_u64().filter(|sequence| (1..=sequences.len() as u64).contains(sequence)).ok_or_else(|| {
            invalid("/target/sequence", format!("`target.sequence` is {value}: the document has {} sequences, counted from 1", sequences.len()))
        })?,
    };
    let last = SEQUENCE_SECONDS - 1.0 / FPS;
    let within = |path: &str, value: &Value| {
        value
            .as_f64()
            .filter(|time| (0.0..=SEQUENCE_SECONDS).contains(time))
            .ok_or_else(|| invalid(path, format!("{value} is not within the sequence (0 to {SEQUENCE_SECONDS} seconds)")))
    };
    let times: Vec<f64> = match (target.get("time"), target.get("range")) {
        (Some(_), Some(_)) => return Err(invalid("/target", "give `time` or `range`, not both".to_owned())),
        (Some(time), None) => {
            let time = within("/target/time", time)?;
            if time >= SEQUENCE_SECONDS {
                return Err(invalid("/target/time", format!("{time} is the sequence's end: a frame starts before {SEQUENCE_SECONDS}")));
            }
            vec![time]
        }
        (None, range) => {
            let (from, to) = match range {
                None => (0.0, last),
                Some(Value::Array(ends)) if ends.len() == 2 => (within("/target/range/0", &ends[0])?, within("/target/range/1", &ends[1])?.min(last)),
                Some(other) => return Err(invalid("/target/range", format!("`target.range` is {other}: [from, to] in seconds"))),
            };
            if from >= to {
                return Err(invalid("/target/range", format!("`target.range` goes from {from} to {to}: from comes before to")));
            }
            let count = match target.get("frames") {
                None => 6,
                Some(frames) => frames
                    .as_u64()
                    .filter(|frames| (2..=12).contains(frames))
                    .ok_or_else(|| invalid("/target/frames", format!("`target.frames` is {frames}: 2 to 12")))?,
            };
            (0..count).map(|at| from + (to - from) * at as f64 / (count - 1) as f64).collect()
        }
    };
    let scale = match params.get("scale") {
        None => 1.0,
        Some(scale) => {
            scale.as_f64().filter(|scale| *scale > 0.0 && *scale <= 2.0).ok_or_else(|| invalid("/scale", format!("`scale` is {scale}: above 0, at most 2")))?
        }
    };
    let max_size = match params.get("maxSize") {
        None => 1024,
        Some(size) => {
            size.as_u64().filter(|size| (16..=4096).contains(size)).ok_or_else(|| invalid("/maxSize", format!("`maxSize` is {size}: 16 to 4096")))? as u32
        }
    };
    let frames: Vec<Value> = times
        .iter()
        .map(|time| {
            let frame = ((time * FPS) + 1e-9).floor() as u64;
            let start = frame as f64 / FPS;
            json!({ "time": start, "frame": frame, "label": format!("{start:.1}s") })
        })
        .collect();
    let columns = frames.len().min(4) as u32;
    let rows = (frames.len() as u32).div_ceil(columns);
    let (w, h) = (FRAME.0 * columns, FRAME.1 * rows);
    let scale = scale.min(f64::from(max_size) / f64::from(w.max(h)));
    let fit = |size: u32| ((f64::from(size) * scale).round() as u32).clamp(1, max_size);
    let (width, height) = (fit(w), fit(h));
    let shown: Vec<String> = frames.iter().filter_map(|frame| frame["time"].as_f64()).map(|time| format!("{time}")).collect();
    let line = sequences.get(sequence as usize - 1).map(|objects| objects.join("|")).unwrap_or_default();
    let view = format!("sequence={sequence};frames={};text={line}", shown.join(","));
    Ok(json!({
        "png": base64::encode(&png_showing(width, height, Some(&view))),
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "scale": scale,
        "sequence": sequence,
        "frames": frames,
        "columns": columns,
        "rows": rows,
    }))
}

/// An unlisted command that does what an engine reaching the file system by path does, so a
/// host's launch can be tested (Kit Process Protocol section 3): it writes a file by a relative path
/// (into the current folder), one into `HOME` and one into the temporary folder, and answers
/// where those are and the names of the variables it was started with.
const PROBE: &str = "probe.environment";

fn probe() -> Value {
    let written = |folder: Option<std::path::PathBuf>, name: &str| -> Option<String> {
        let path = folder.map_or_else(|| std::path::PathBuf::from(name), |folder| folder.join(name));
        std::fs::write(&path, b"probe").ok()?;
        Some(std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().into_owned())
    };
    let mut variables: Vec<String> = std::env::vars_os().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
    variables.sort();
    let var = |name: &str| std::env::var(name).ok();
    json!({
        "cwd": std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned()),
        "wrote": [
            written(None, "probe-cwd.txt"),
            written(std::env::var_os("HOME").map(std::path::PathBuf::from), "probe-home.txt"),
            written(Some(std::env::temp_dir()), "probe-tmp.txt"),
        ],
        "variables": variables,
        "env": {
            "HOME": var("HOME"),
            "TMPDIR": var("TMPDIR"),
            "XDG_RUNTIME_DIR": var("XDG_RUNTIME_DIR"),
            "XDG_CACHE_HOME": var("XDG_CACHE_HOME"),
            "TEMP": var("TEMP"),
            "TMP": var("TMP"),
            "XDG_CONFIG_HOME": var("XDG_CONFIG_HOME"),
            "LANG": var("LANG"),
            "LC_ALL": var("LC_ALL"),
            "TZ": var("TZ"),
        },
    })
}

/// `view.screenshot` of the canvas (section 7): at `scale` up to [`MAX_SCALE`], brought down to fit
/// `maxSize`; a larger scale and any `target` are refused, never answered with another image.
fn screenshot(params: &ViewScreenshotParams) -> Handled {
    if params.target.is_some() {
        return Err(RpcError::kit_detail(ErrorReason::InvalidParams, "the mock kit draws its whole canvas, not a `target`: call it without `target`"));
    }
    let asked = params.scale.unwrap_or(1.0);
    if !(asked.is_finite() && asked > 0.0 && asked <= 2.0) {
        return Err(RpcError::invalid_params("`scale` is above 0 and at most 2"));
    }
    let side = params.max_size.unwrap_or(1024).clamp(16, 4096);
    let (w, h) = CANVAS;
    let scale = asked.min(f64::from(side) / f64::from(w.max(h)));
    let most = *MAX_SCALE;
    if scale > most + 1e-9 {
        return Err(RpcError::kit_detail(
            ErrorReason::InvalidParams,
            format!("the mock kit draws previews at scale {most} at most; ask for scale {most} or less"),
        ));
    }
    let fit = |size: u32| ((f64::from(size) * scale).round() as u32).clamp(1, side);
    let (width, height) = (fit(w), fit(h));
    to_value(Image::png(width, height, base64::encode(&png_showing(width, height, None))))
}

/// A white 8-bit greyscale PNG of `width` × `height`, its image data in stored (uncompressed)
/// deflate blocks, with `view` as its `tEXt` `view` when given.
fn png_showing(width: u32, height: u32, view: Option<&str>) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
        let start = png.len();
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        let crc = crc32(&png[start..]);
        png.extend_from_slice(&crc.to_be_bytes());
    }
    let row = usize::try_from(width).unwrap_or(0);
    let mut raw = Vec::new();
    for _ in 0..height {
        raw.push(0); // filter: none
        raw.extend(std::iter::repeat_n(0xFF, row));
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &raw {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (index, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(index + 1 == blocks.len()));
        let len = u16::try_from(block.len()).unwrap_or(u16::MAX);
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 0, 0, 0, 0]);
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut png, b"IHDR", &header);
    chunk(&mut png, b"IDAT", &zlib);
    if let Some(view) = view {
        chunk(&mut png, b"tEXt", &[b"view\0".as_slice(), view.as_bytes()].concat());
    }
    chunk(&mut png, b"IEND", &[]);
    png
}

/// The `documentId` of an object-model request.
fn document_param(params: &Value) -> Result<String, RpcError> {
    params["documentId"].as_str().map(str::to_owned).ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn to_value<T: Serialize>(value: T) -> Handled {
    serde_json::to_value(value).map_err(|error| RpcError::internal(error.to_string()))
}

fn invalid_command_params(errors: Vec<Value>) -> RpcError {
    let detail = errors.first().and_then(|error| error["message"].as_str()).map(str::to_owned);
    RpcError::kit_data(ErrorData { reason: ErrorReason::InvalidParams, detail, errors: Some(errors) })
}
