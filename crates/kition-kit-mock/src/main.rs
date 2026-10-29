//! A minimal kit for plain-text `.mocktext` documents. It implements the
//! headless parts of Kit Protocol v1 so the host and the conformance suite can
//! be tested without a real editor.
//!
//! `KITION_KIT_MOCK_FAULT` makes it misbehave on purpose, which proves that
//! the conformance checks can fail: `stdout-after-ready` or `ignore-token`.

mod kit;

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use kition_kit_protocol::framing::{self, read_frame_async, write_frame_async};
use kition_kit_protocol::launch::{
    ENV_ENDPOINT, ENV_PROTOCOL, ENV_SURFACE, ENV_TOKEN, LAUNCH_ARG, ReadyLine, Surface,
    is_valid_token,
};
use kition_kit_protocol::transport::{BoxReader, BoxWriter, Listener};
use kition_kit_protocol::{Message, PROTOCOL_VERSION, Response};
use serde_json::Value;
use tokio::io::BufReader;

use kit::{Connection, Fault, Kit, Writer};

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() != Some(LAUNCH_ARG) {
        eprintln!("kition-kit-mock: start through the Kition kit host ({LAUNCH_ARG})");
        return ExitCode::from(2);
    }
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    if env(ENV_PROTOCOL) != PROTOCOL_VERSION.to_string() {
        eprintln!("kition-kit-mock: unsupported {ENV_PROTOCOL}");
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

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
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
    if stdout
        .write_all(ReadyLine::default().to_line().as_bytes())
        .and_then(|()| stdout.flush())
        .is_err()
    {
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

async fn handle_connection(kit: Arc<Kit>, reader: BoxReader, writer: BoxWriter) {
    let writer: Writer = Arc::new(tokio::sync::Mutex::new(writer));
    let mut connection = Connection::new(Arc::clone(&writer));
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let frame = match read_frame_async(&mut reader, &mut line).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if error.is_recoverable() => {
                let reply = Response {
                    id: None,
                    outcome: Err(kition_kit_protocol::RpcError::parse_error()),
                };
                send(&writer, &reply.to_value()).await;
                continue;
            }
            Err(_) => break,
        };
        let message = match Message::parse(&frame) {
            Ok(message) => message,
            Err(reply) => {
                send(&writer, &reply.to_value()).await;
                continue;
            }
        };
        let step = kit.handle(&mut connection, message);
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
            break;
        }
    }
    kit.disconnect(&connection);
}

async fn send(writer: &Writer, message: &Value) {
    let Ok(frame) = framing::encode(message) else {
        return;
    };
    let mut writer = writer.lock().await;
    let _ = write_frame_async(&mut *writer, &frame).await;
}
