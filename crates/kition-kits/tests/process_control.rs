// Copied from kition-sdk crates/kition-kits/tests/process_control.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! This test executable also serves as its own deliberately slow kit. No installed kit or
//! interpreter is needed. Every child uses the same wire document id, exercising host routing.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kition_kit_process_protocol::framing::{self, read_frame_async, write_frame_async};
use kition_kit_process_protocol::transport::{BoxReader, BoxWriter, Listener};
use kition_kit_process_protocol::{Message, Request, RequestId};
use kition_kits::{Caller, KitDefinition, KitError, KitManager};
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{Mutex as AsyncMutex, oneshot};

const MANIFEST: &str = include_str!("support/example.json");

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--list") {
        println!("process_control: test");
        return;
    }
    // Match the standard test harness's name filtering when another unit test is selected.
    if arguments.first().filter(|argument| !argument.starts_with('-')).is_some_and(|filter| !"process_control".contains(filter)) {
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    runtime.block_on(async {
        if std::env::args().nth(1).as_deref() == Some("--kition-kit") {
            child().await;
        } else {
            tokio::time::timeout(Duration::from_secs(30), scenarios()).await.expect("process-control scenarios exceeded their budget");
        }
    });
}

struct Peer {
    writer: AsyncMutex<BoxWriter>,
    pending: Mutex<HashMap<RequestId, oneshot::Sender<Value>>>,
    next: AtomicI64,
}

impl Peer {
    async fn send(&self, message: Value) {
        let frame = framing::encode(&message).unwrap();
        let _ = write_frame_async(&mut *self.writer.lock().await, &frame).await;
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        let id = RequestId::Number(self.next.fetch_sub(1, Ordering::Relaxed));
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await;
        receive.await.unwrap()
    }
}

#[derive(Default)]
struct Data {
    file: Option<String>,
    text: String,
    version: String,
    dirty: bool,
}

impl Data {
    fn document(&self) -> Value {
        json!({ "documentId": "doc", "name": "Test.example", "title": "Test", "format": "example",
            "readOnly": false, "dirty": self.dirty, "canUndo": false, "canRedo": false, "conflict": false })
    }
}

#[derive(Default)]
struct Shared {
    data: AsyncMutex<Data>,
    host: AsyncMutex<Option<Arc<Peer>>>,
}

async fn child() {
    let mut listener = Listener::bind(&std::env::var("KITION_KIT_ENDPOINT").unwrap()).unwrap();
    {
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(kition_kit_process_protocol::launch::ReadyLine::default().to_line().as_bytes()).unwrap();
        stdout.flush().unwrap();
    }
    let shared = Arc::new(Shared::default());
    loop {
        let (reader, writer) = listener.accept().await.unwrap();
        let peer = Arc::new(Peer { writer: AsyncMutex::new(writer), pending: Mutex::default(), next: AtomicI64::new(-1) });
        tokio::spawn(connection(Arc::clone(&shared), peer, reader));
    }
}

async fn connection(shared: Arc<Shared>, peer: Arc<Peer>, reader: BoxReader) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while let Ok(Some(frame)) = read_frame_async(&mut reader, &mut line).await {
        match Message::parse(&frame).unwrap() {
            Message::Response(response) => {
                if let Some(id) = response.id
                    && let Some(sender) = peer.pending.lock().unwrap().remove(&id)
                {
                    sender.send(response.outcome.unwrap()).unwrap();
                }
            }
            Message::Request(request) => {
                let shared = Arc::clone(&shared);
                let peer = Arc::clone(&peer);
                tokio::spawn(async move { answer(shared, peer, request).await });
            }
            // Deliberately ignores cancellation, like an uninterruptible backend call.
            Message::Notification(_) => {}
        }
    }
}

async fn answer(shared: Arc<Shared>, peer: Arc<Peer>, request: Request) {
    let params = request.params.unwrap_or_else(|| json!({}));
    let result = match request.method.as_str() {
        "kit.initialize" => {
            if params["role"] == "host" {
                *shared.host.lock().await = Some(Arc::clone(&peer));
            }
            let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
            json!({ "protocolVersion": 1, "kit": { "id": "kit.example", "version": manifest["version"] },
                "capabilities": { "surfaces": ["headless"], "formats": { "open": ["example"], "save": ["example"], "export": [] } } })
        }
        "kit.shutdown" => {
            peer.send(json!({ "jsonrpc": "2.0", "id": request.id, "result": {} })).await;
            std::process::exit(0);
        }
        "file.open" => {
            let host = shared.host.lock().await.clone().unwrap();
            let file = params["file"].as_str().unwrap().to_owned();
            let bytes = host.call("files.read", json!({ "handle": file })).await;
            let mut data = shared.data.lock().await;
            if data.file.as_deref() != Some(file.as_str()) {
                data.text = String::from_utf8(kition_kit_process_protocol::base64::decode(bytes["data"].as_str().unwrap()).unwrap()).unwrap();
                data.version = bytes["version"].as_str().unwrap().to_owned();
                data.file = Some(file);
            }
            data.document()
        }
        "file.list" => {
            let data = shared.data.lock().await;
            json!({ "documents": if data.file.is_some() { vec![data.document()] } else { Vec::new() } })
        }
        "file.save" => {
            let host = shared.host.lock().await.clone().unwrap();
            let mut data = shared.data.lock().await;
            let written = host
                .call(
                    "files.write",
                    json!({ "handle": data.file, "data": kition_kit_process_protocol::base64::encode(data.text.as_bytes()),
                "offset": 0, "final": true, "expected": data.version }),
                )
                .await;
            data.version = written["version"].as_str().unwrap().to_owned();
            data.dirty = false;
            json!({ "name": "Test.example", "version": data.version })
        }
        "view.describe" => {
            let data = shared.data.lock().await;
            let address_space = std::fs::read_to_string("/proc/self/limits").ok().and_then(|limits| {
                limits.lines().find(|line| line.starts_with("Max address space")).and_then(|line| line.split_whitespace().nth(3)).map(str::to_owned)
            });
            json!({ "summary": data.text, "state": { "pid": std::process::id(), "addressSpace": address_space } })
        }
        "commands.execute" => {
            let mut data = shared.data.lock().await;
            if params["command"] == "hang" {
                peer.send(json!({ "jsonrpc": "2.0", "method": "kit.progress", "params": {
                    "token": request.id, "title": "Waiting", "fraction": 0.25, "done": false,
                } }))
                .await;
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
            if params["command"] == "memory" {
                let mut memory = vec![42u8; 256 * 1024 * 1024];
                std::hint::black_box(&mut memory);
                tokio::time::sleep(Duration::from_secs(20)).await;
                std::hint::black_box(memory);
            }
            data.text.push_str(params["params"]["text"].as_str().unwrap_or_default());
            data.dirty = true;
            json!({ "changed": true })
        }
        _ => {
            peer.send(json!({ "jsonrpc": "2.0", "id": request.id, "error": { "code": -32601, "message": "method not found" } })).await;
            return;
        }
    };
    peer.send(json!({ "jsonrpc": "2.0", "id": request.id, "result": result })).await;
}

async fn scenarios() {
    let definition = KitDefinition::from_manifest_text(MANIFEST).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    for file in ["a.example", "b.example"] {
        std::fs::write(workspace.path().join(file), "original").unwrap();
    }
    let limits = kition_kits::control::Limits { call_timeout: Duration::from_secs(3), idle_timeout: Duration::from_secs(2), memory_limit_bytes: None };
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(definition, Some(std::env::current_exe().unwrap()))]).with_limits(limits).unwrap();
    let a = kits.open(Caller::Agent, "a.example").await.unwrap();
    let b = kits.open(Caller::Agent, "b.example").await.unwrap();
    assert_ne!(a.document_id, b.document_id, "process-local ids must never collide");
    assert_ne!(a.details["pid"], b.details["pid"], "documents of one kit must have independent workers");

    let (cancel, cancelled) = tokio::sync::watch::channel(false);
    let (progress, mut progress_rx) = tokio::sync::mpsc::channel(4);
    let control = kition_kit_host::client::RequestControl::new(cancelled, Some(progress));
    let slow = control.scope(kits.execute(Caller::Agent, "kit.example", &a.document_id, "hang", serde_json::Map::new()));
    tokio::pin!(slow);
    let progress = tokio::select! {
        progress = progress_rx.recv() => progress.unwrap(),
        result = &mut slow => panic!("slow request ended before progress: {result:?}"),
    };
    assert_eq!(progress.title, "Waiting");
    let b_saved =
        kits.execute(Caller::Agent, "kit.example", &b.document_id, "append", serde_json::Map::from_iter([("text".into(), json!(" edited"))])).await.unwrap();
    assert_eq!(b_saved.document.unwrap().summary, "original edited", "a hung document must not block another");
    cancel.send(true).unwrap();
    assert!(matches!(slow.await, Err(KitError::Cancelled)));
    let reopened = kits.document(Caller::Agent, "kit.example", &a.document_id).await.unwrap();
    assert_ne!(reopened.details["pid"], a.details["pid"]);
    assert_eq!(reopened.document_id, a.document_id, "the host id survives a restart");

    let timeout = kits.execute(Caller::Agent, "kit.example", &a.document_id, "hang", serde_json::Map::new()).await.unwrap_err();
    assert!(matches!(timeout, KitError::Timeout { .. }));
    assert_eq!(kits.document(Caller::Agent, "kit.example", &a.document_id).await.unwrap().summary, "original");

    // Idle reclaim saves dirty bytes before stopping; the next use keeps the same public id.
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if std::fs::read_to_string(workspace.path().join("b.example")).unwrap() == "original edited" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("idle reclaim did not save the dirty document");
    let restored = kits.document(Caller::Agent, "kit.example", &b.document_id).await.unwrap();
    assert_eq!(restored.summary, "original edited");
    assert_ne!(restored.details["pid"], b.details["pid"]);
    kits.shutdown().await;
    let memory_limits = kition_kits::control::Limits { memory_limit_bytes: Some(512 * 1024 * 1024), ..limits };
    let limited = KitManager::new(Some(workspace.path().to_path_buf()), vec![(definition, Some(std::env::current_exe().unwrap()))]).with_limits(memory_limits);
    if cfg!(target_os = "linux") {
        let limited = limited.unwrap();
        let document = limited.open(Caller::User, "a.example").await.unwrap();
        assert_eq!(document.details["addressSpace"], (512u64 * 1024 * 1024).to_string());
        limited.shutdown().await;
    } else if cfg!(target_os = "macos") {
        limited.unwrap().shutdown().await;
        let limited = KitManager::new(Some(workspace.path().to_path_buf()), vec![(definition, Some(std::env::current_exe().unwrap()))])
            .with_limits(kition_kits::control::Limits { memory_limit_bytes: Some(128 * 1024 * 1024), ..limits })
            .unwrap();
        let document = limited.open(Caller::User, "a.example").await.unwrap();
        let error = limited.execute(Caller::User, "kit.example", &document.document_id, "memory", serde_json::Map::new()).await.unwrap_err();
        assert!(matches!(error, KitError::MemoryLimit { .. }), "{error}");
        limited.shutdown().await;
    } else {
        assert!(limited.is_err(), "unsupported platforms must refuse a memory ceiling");
    }
    println!("process control: cancellation, timeout, independent documents and save-before-reclaim passed");
}
