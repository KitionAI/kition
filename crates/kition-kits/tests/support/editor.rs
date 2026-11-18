// Copied from kition-sdk crates/kition-kits/tests/support/editor.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The matrix kit behind a real Kit AI bridge connection. Select with KITION_TEST_READER=editor.
use std::collections::HashMap;
use std::path::Path;

use kition_kits::{Caller, KitDefinition, KitManager, tools};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct State {
    versions: HashMap<String, Value>,
    served: Option<(Vec<u8>, std::time::SystemTime)>,
    file: std::path::PathBuf,
    seen: Option<String>,
    native_basis: Option<Value>,
    reread: Option<(String, Value)>,
    large: bool,
}

fn file(state: &State) -> Option<(Vec<u8>, std::time::SystemTime)> {
    Some((std::fs::read(&state.file).ok()?, std::fs::metadata(&state.file).ok()?.modified().ok()?))
}

pub fn attach(kits: &KitManager, workspace: &Path, kit: &'static KitDefinition, binary: &Path, path: &str) -> KitManager {
    if std::env::var("KITION_TEST_READER").as_deref() != Ok("editor") {
        return kits.clone();
    }
    let backend = KitManager::new(Some(workspace.to_owned()), vec![(kit, Some(binary.to_owned()))]);
    let native = backend.clone();
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let path = path.to_owned();
    let file_path = workspace.join(&path);
    let frontend = kits.clone();
    tokio::spawn(async move {
        let mut state = State { file: file_path, ..State::default() };
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let result = if message["method"] == "kit/documents" {
                Ok(json!({"documents":[{"path":path,"kit":kit.id,"dirty":false,"revision":1,
                    "capabilities":["context","changes","premises","model","check"]}]}))
            } else {
                let tool = message["params"]["tool"].as_str().unwrap_or_default();
                let args = message["params"]["arguments"].clone();
                let result = answer(&backend, &frontend, kit, &path, tool, args, &mut state).await;
                if result.is_ok() && matches!(tool, "batch" | "run") {
                    state.served = file(&state);
                }
                result
            };
            let reply = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(error) => {
                    if let Ok(native) = serde_json::from_str::<Value>(&error)
                        && native["error"].is_object()
                    {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":native["error"]["message"],
                            "data":{"reason":native["error"]["code"],"step":native["error"]["index"],
                                "completed":native.get("completed"),"rolledBack":native.get("rolledBack")}}})
                    } else {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error}})
                    }
                }
            };
            bridge.receive(session, &reply).unwrap();
        }
        backend.shutdown().await;
    });
    native
}

async fn answer(
    backend: &KitManager,
    frontend: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    tool: &str,
    args: Value,
    state: &mut State,
) -> Result<Value, String> {
    // Headless reread is the mock editor's file-watcher/import operation.
    if tool == "version" && state.served != file(state) {
        let inspected = tools::call(backend, &format!("{}_inspect", kit.agent.prefix), &json!({"path":path,"preview":false,"basis":state.native_basis}))
            .await
            .ok_or("missing inspect")?
            .map_err(|error| error.structured().to_string())?
            .output;
        if let Some(since) = &state.seen
            && inspected["others"].is_object()
            && inspected["others"].get("truncated").is_none()
        {
            state.reread = Some((since.clone(), inspected["others"].clone()));
        }
        state.native_basis = inspected.get("revision").cloned();
        state.served = file(state);
    }
    let view = backend.open(Caller::Agent, path).await.map_err(|error| error.to_string())?;
    let doc = &view.document_id;
    let model = |method: &'static str, params: Value| async move {
        backend.model(Caller::Agent, kit.id, doc, method, params.as_object().cloned().unwrap_or_default()).await.map_err(|error| error.to_string())
    };
    let described = model("model.describe", json!({})).await.unwrap_or(Value::Null);
    frontend.remember_described(kit.id, &described);
    if described.is_null() {
        let version = format!("unmodeled:{}:{}", view.document_id, view.version);
        match tool {
            "version" => return Ok(json!({"version":version})),
            "changes" => return Ok(json!({"version":version,"changes":null,"by":"outside","unavailable":"no object model"})),
            _ => {}
        }
    }
    match tool {
        "describe" => Ok(described),
        "version" => {
            let version = model("model.version", json!({})).await?;
            state.seen = version["version"].as_str().map(str::to_owned);
            if version["version"].as_str().is_some_and(|version| state.versions.contains_key(version)) {
                return Ok(version);
            }
            let inventory = model("model.batch", json!({"origin":{"kind":"agent","principal":"matrix"},"ops":[],"objects":true})).await?;
            state.large = inventory["objects"].as_array().is_some_and(|objects| objects.len() > 20_000);
            if state.large {
                return Ok(version);
            }
            let load: Vec<_> = inventory["objects"].as_array().into_iter().flatten().map(|object| json!({"target":object["id"]})).collect();
            let loaded = model("model.batch", json!({"origin":{"kind":"agent","principal":"matrix"},"ops":[],"load":load})).await?;
            let objects: Map<String, Value> = loaded["loaded"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|object| {
                    let mut fields = object["fields"].as_object().cloned().unwrap_or_default();
                    fields.insert("$type".into(), object["type"].clone());
                    (object["id"].as_str().unwrap().to_owned(), json!(fields))
                })
                .collect();
            state.versions.insert(version["version"].as_str().ok_or("missing version")?.to_owned(), json!({"objects":objects}));
            Ok(version)
        }
        "changes" => {
            let mut changes = model("model.changes", args.clone()).await?;
            let now = model("model.version", json!({})).await?;
            state.seen = now["version"].as_str().map(str::to_owned);
            if state.large {
                if changes["changes"].is_null()
                    && let Some((since, reread)) = &state.reread
                    && args["since"] == *since
                {
                    changes = json!({"version":now["version"],"by":"outside","changes":reread});
                }
                return Ok(changes);
            }
            let inventory = model("model.batch", json!({"origin":{"kind":"agent","principal":"matrix"},"ops":[],"objects":true})).await?;
            let load: Vec<_> = inventory["objects"].as_array().into_iter().flatten().map(|object| json!({"target":object["id"]})).collect();
            let loaded = model("model.batch", json!({"origin":{"kind":"agent","principal":"matrix"},"ops":[],"load":load})).await?;
            let objects: Map<String, Value> = loaded["loaded"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|object| {
                    let mut fields = object["fields"].as_object().cloned().unwrap_or_default();
                    fields.insert("$type".into(), object["type"].clone());
                    (object["id"].as_str().unwrap().to_owned(), json!(fields))
                })
                .collect();
            state.versions.insert(now["version"].as_str().ok_or("missing version")?.to_owned(), json!({"objects":objects}));
            if changes["changes"].is_null()
                && let (Some(before), Some(after)) =
                    (args["since"].as_str().and_then(|v| state.versions.get(v)), now["version"].as_str().and_then(|v| state.versions.get(v)))
            {
                let schema = kition_kits::drafts::schema_of(&described)?;
                changes = json!({"by":"outside","version":now["version"],"changes":kition_kdm::reread::diff_read_again(&schema,before,after).to_recorded_json(&schema)});
                let pairing = kition_kdm::reread::pair(&schema, before, after);
                changes["changes"]["$references"] = json!(
                    before["objects"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter_map(|(id, _)| pairing.after(id).filter(|now| *now != id).map(|now| (id.clone(), json!(now))))
                        .collect::<Map<_, _>>()
                );
            }
            Ok(changes)
        }
        "premise" => {
            let method = args["method"].as_str().ok_or("missing premise method")?;
            let params = args["params"].as_object().cloned().unwrap_or_default();
            if method == "blob-support" {
                return Ok(json!({"available":described["blobBytes"] == true}));
            }
            if method == "blob" {
                return model("model.blob.read", json!(params)).await;
            }
            if method == "state" {
                return backend
                    .context(Caller::Agent, kit.id, doc, "context.get", Map::new())
                    .await
                    .map(|v| v.unwrap_or(Value::Null))
                    .map_err(|e| e.to_string());
            }
            if method == "derived" {
                return model("model.derived", json!(params)).await;
            }
            if method == "carried" {
                return model("model.carried", json!(params)).await;
            }
            let saved = backend.context(Caller::Agent, kit.id, doc, "context.get", Map::new()).await.map_err(|e| e.to_string())?;
            let context: Map<_, _> = ["on", "part", "time"].into_iter().filter_map(|name| params.get(name).map(|v| (name.to_owned(), v.clone()))).collect();
            if !context.is_empty() {
                backend.context(Caller::Agent, kit.id, doc, "context.set", context).await.map_err(|e| e.to_string())?;
            }
            let result = backend
                .context(Caller::Agent, kit.id, doc, &format!("context.{method}"), params)
                .await
                .map(|v| {
                    v.unwrap_or_else(|| match method {
                        "identity" => json!({"unproven":[]}),
                        "inputs" => json!({"inputs":[]}),
                        _ => Value::Null,
                    })
                })
                .map_err(|e| e.to_string());
            if let Some(saved) = saved {
                backend
                    .context(Caller::Agent, kit.id, doc, "context.restore", saved.as_object().cloned().unwrap_or_default())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            result
        }
        "batch" => {
            if args["ops"].as_array().is_some_and(|ops| !ops.is_empty()) {
                let current = tools::call(backend, &format!("{}_inspect", kit.agent.prefix), &json!({"path":path,"preview":false}))
                    .await
                    .ok_or("missing inspect")?
                    .map_err(|error| error.structured().to_string())?
                    .output;
                let mut input = args;
                input["path"] = json!(path);
                input["basis"] = current["revision"].clone();
                return tools::call(backend, &format!("{}_batch", kit.agent.prefix), &input)
                    .await
                    .ok_or("missing batch")?
                    .map(|out| out.output)
                    .map_err(|error| error.structured().to_string());
            }
            let result = model("model.batch", args.clone()).await?;
            Ok(result)
        }
        "query" => model("model.query", args).await,
        "commands" => {
            let commands = backend.commands(Caller::Agent, kit.id, Some(doc), None).await.map_err(|e| e.to_string())?;
            Ok(
                json!({"commands":commands.iter().map(|command|json!({"id":command.id,"title":command.title,"schema":command.params,"enabled":command.enabled,"mutates":command.mutates})).collect::<Vec<_>>(),"total":commands.len()}),
            )
        }
        _ => {
            let mut input = args;
            input["path"] = json!(path);
            if tool == "run" {
                let current = tools::call(backend, &format!("{}_inspect", kit.agent.prefix), &json!({"path":path,"preview":false}))
                    .await
                    .ok_or("missing inspect")?
                    .map_err(|error| error.structured().to_string())?
                    .output;
                input["basis"] = current["revision"].clone();
                for step in input["steps"].as_array_mut().into_iter().flatten() {
                    let context = step["context"].clone();
                    step.as_object_mut().unwrap().remove("context");
                    if let Some(on) = context.get("on") {
                        step["on"] = on.clone();
                    }
                    for name in ["part", "time"] {
                        if let Some(value) = context.get(name) {
                            if !step["at"].is_object() {
                                step["at"] = json!({});
                            }
                            step["at"][name] = value.clone();
                        }
                    }
                }
            }
            tools::call(backend, &format!("{}_{tool}", kit.agent.prefix), &input)
                .await
                .ok_or_else(|| format!("unknown editor tool {tool}"))?
                .map(|out| out.output)
                .map_err(|error| error.structured().to_string())
        }
    }
}
