// Copied from kition-sdk crates/kition-kit-mock/src/main.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A minimal kit for plain-text `.mocktext` documents. It implements the
//! headless parts of Kit Process Protocol version 1, reading and writing its
//! documents through the host's `files.*`, so a host and the conformance suite
//! can be tested without a real editor. It shares no code with
//! `kition-kit-server`: it is a second, independent kit side, which enforces what a kit process
//! serving that crate enforces (a `model.batch` on the agent's connection, a read included, names
//! the agent as its origin), so a host that only passes on the mock fails here first.
//!
//! `KITION_KIT_MOCK_FAULT` makes it misbehave on purpose, which proves that
//! the conformance checks can fail: `stdout-after-ready` or `ignore-token`.
//! `KITION_KIT_MOCK_MAX_SCALE` is the largest `scale` its `view.screenshot`
//! draws (1 unless given), so a host can be tested against a kit that draws
//! previews at scale 2 and one that refuses it. `KITION_KIT_MOCK_SCHEMA=every-kind`
//! adds an enum, a read-only field, a reference, and a read-only type to its
//! object model; `KITION_KIT_MOCK_SCHEMA=tool-ids` adds types it numbers and names by those
//! numbers (tool ids, KitObjectModel OM9). `KITION_KIT_MOCK_REPLICA=full` enables snapshot export/open for draft review;
//! `export` enables only export, exercising file-copy review when replica opening fails. Without
//! this option replica transport is absent. `KITION_KIT_MOCK_FILE_REPLICA=1` keeps the document's
//! replica in its file (the text, a marker line, the content in base64), as kits whose files embed
//! their replica do, and serves `document.identity` and `document.fork` (feature
//! `document.identity`), `model.export` and `model.import`; without it the mock declares neither
//! request and answers both "method not found". `KITION_KIT_MOCK_SCHEMA=none` leaves documents without
//! an object model (every `model.*` request is not found). Documents with one answer `model.version` and
//! `model.changes` (a change set since a version, KDM `Replica::changes_since`); a reload starts the
//! object model again from the text. `document.check` warns (`mock.todo`) while the text holds `TODO`. It reports its manifest's version (`kit.json`), or what
//! `KITION_KIT_MOCK_VERSION` names when it stands in for another kit
//! (`KITION_KIT_MOCK_AS`) or plays a stale executable. `KITION_KIT_MOCK_BATCH=commands` (in a deck, its editing commands)
//! runs `text.append` and `text.clear` inside a `model.batch`, as a real kit runs its
//! commands there. `KITION_KIT_MOCK_PARTS=slides` gives documents slides (a line each, objects
//! `|`-separated, their ids unique only within a slide) and the commands `slide.go`,
//! `slide.inspect` and `shape.text`, which edits an object of the current slide. `KITION_KIT_MOCK_PARTS=deck` makes documents decks: slides and
//! shapes in an object model whose ids (`slide:<n>`, `shape:<n>`) survive edits and reloads, with
//! commands that edit, delete and move shapes and insert slides, and `edit.undo` on the object model
//! (`deck.rs`); with `KITION_KIT_MOCK_DECK=nested` the deck is modelled as a real slide kit models it
//! (shapes numbered per slide with tool ids `shape:<slideId>/<n>`, their text in an owned body of
//! paragraphs without tool ids, slide notes `slide:<slideId>/note:<n>`). `KITION_KIT_MOCK_PARTS=tracks` makes documents timelines of clips on tracks whose
//! integer clip ids survive edits and reloads, with commands that address clips by id, by the
//! selection or by place (a track and the playhead), and `context.under` (`tracks.rs`). `KITION_KIT_MOCK_PARTS=space` makes documents scenes of nodes in space (a json
//! `location` and a `parent` as positions, meshes addressed by element index), with commands that
//! name a node by key, name or world point, `context.under`, `context.covered` and `model.derived`
//! (`space.rs`). `KITION_KIT_MOCK_PARTS=stack` makes documents images whose layers are a KDM tree
//! (groups holding layers), with commands that name a layer by id or by its index among its
//! siblings, `context.under` and the root's derived value (`stack.rs`). `KITION_KIT_MOCK_PARTS=timeline` gives documents a
//! timeline (a sequence a line, ten seconds each), a playhead and an open sequence as editor state,
//! and the render command `file.render` (its manifest's `agent.render`), which draws an explicit
//! view (`target.time`, `target.range` with `target.frames`, `target.sequence`) as a PNG whose
//! bytes carry that view, with the frames it shows. The unlisted command `probe.environment` writes files by path (the current
//! folder, `HOME`, the temporary folder) and answers its folders and variable names, so a host's
//! launch environment can be tested.

mod comments;
mod deck;
mod kit;
mod matrix;
mod order;
mod paragraphs;
mod projected;
mod raster;
mod reels;
mod replay;
mod space;
mod stack;
mod structure;
mod tracks;

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use kition_kit_process_protocol::framing::{self, read_frame_async, write_frame_async};
use kition_kit_process_protocol::launch::{ENV_ENDPOINT, ENV_PROTOCOL, ENV_SURFACE, ENV_TOKEN, LAUNCH_ARG, ReadyLine, Surface, is_valid_token};
use kition_kit_process_protocol::transport::{BoxReader, BoxWriter, Listener};
use kition_kit_process_protocol::{Message, Response};
use serde_json::Value;
use tokio::io::BufReader;

use kit::{Connection, Fault, Kit, Writer};

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() != Some(LAUNCH_ARG) {
        eprintln!("kition-kit-mock: start through the Kition kit host ({LAUNCH_ARG})");
        return ExitCode::from(2);
    }
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    // Another version still starts: the ready line says the kit's, and kit.initialize refuses.
    if std::env::var(ENV_PROTOCOL).is_err() {
        eprintln!("kition-kit-mock: {ENV_PROTOCOL} is not set");
        return ExitCode::from(2);
    }
    let token = env(ENV_TOKEN);
    if !is_valid_token(&token) {
        eprintln!("kition-kit-mock: {ENV_TOKEN} is missing or malformed");
        return ExitCode::from(2);
    }
    if Surface::from_env(&env(ENV_SURFACE)).is_none() {
        eprintln!("kition-kit-mock: {ENV_SURFACE} must be headless");
        return ExitCode::from(2);
    }
    let fault = Fault::from_env(&env("KITION_KIT_MOCK_FAULT"));
    let endpoint = env(ENV_ENDPOINT);

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-kit-mock: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(serve(endpoint, Kit::new(token, fault)))
}

async fn serve(endpoint: String, kit: Kit) -> ExitCode {
    let mut listener = match Listener::bind(&endpoint) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("kition-kit-mock: cannot listen: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = std::io::stdout().lock();
    if stdout.write_all(ReadyLine::default().to_line().as_bytes()).and_then(|()| stdout.flush()).is_err() {
        return ExitCode::FAILURE;
    }
    drop(stdout);

    let kit = Arc::new(kit);
    loop {
        match listener.accept().await {
            Ok((reader, writer)) => {
                tokio::spawn(handle_connection(Arc::clone(&kit), reader, writer));
            }
            Err(error) => {
                eprintln!("kition-kit-mock: accept failed: {error}");
                return ExitCode::FAILURE;
            }
        }
    }
}

/// Reads one connection. The host's answers to the kit's own requests are routed at once; every
/// other message is handled in order on a blocking worker, which may wait for such an answer.
async fn handle_connection(kit: Arc<Kit>, reader: BoxReader, writer: BoxWriter) {
    let writer: Writer = Arc::new(tokio::sync::Mutex::new(writer));
    let connection = Connection::new(Arc::clone(&writer));
    let id = connection.id();
    let (queue, mut messages) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let mut worker = tokio::spawn({
        let kit = Arc::clone(&kit);
        let writer = Arc::clone(&writer);
        async move {
            let mut connection = connection;
            while let Some(message) = messages.recv().await {
                let handled = tokio::task::spawn_blocking({
                    let kit = Arc::clone(&kit);
                    move || {
                        let step = kit.handle(&mut connection, message);
                        (connection, step)
                    }
                })
                .await;
                let Ok((back, step)) = handled else { return };
                connection = back;
                if let Some(reply) = step.reply {
                    send(&writer, &reply.to_value()).await;
                }
                for (target, notification) in step.broadcast {
                    send(&target, &notification).await;
                }
                if step.shutdown {
                    std::process::exit(0);
                }
                if step.close {
                    return;
                }
            }
        }
    });
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut worker_done = false;
    loop {
        let read = tokio::select! {
            read = read_frame_async(&mut reader, &mut line) => read,
            _ = &mut worker => {
                worker_done = true;
                break;
            }
        };
        let frame = match read {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if error.is_recoverable() => {
                let reply = Response { id: None, outcome: Err(kition_kit_process_protocol::RpcError::parse_error()) };
                send(&writer, &reply.to_value()).await;
                continue;
            }
            Err(_) => break,
        };
        match Message::parse(&frame) {
            Ok(Message::Response(response)) => kit.answer(id, response),
            Ok(message) => {
                let _ = queue.send(message);
            }
            Err(reply) => send(&writer, &reply.to_value()).await,
        }
    }
    let was_host = kit.disconnect(id);
    drop(queue);
    if !worker_done {
        let _ = worker.await;
    }
    // The host is gone without `kit.shutdown`: the kit ends, its documents unsaved (section 4).
    if was_host {
        std::process::exit(0);
    }
}

async fn send(writer: &Writer, message: &Value) {
    let Ok(frame) = framing::encode(message) else {
        return;
    };
    let mut writer = writer.lock().await;
    let _ = write_frame_async(&mut *writer, &frame).await;
}
