// Copied from kition-sdk crates/kition-kits/src/tools/history.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Immutable bytes retained independently of reloadable kit sessions.
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_host::kit_files::{HostService, KitFiles};
use kition_kit_process_protocol::{RpcError, base64};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::journal::{Journals, Since};
use crate::manager::{DocumentView, KitManager};

const CHUNK: usize = 1024 * 1024;
const REFERENCES: usize = 20_000;

#[derive(Default)]
struct Document {
    snapshot: Option<(String, Map<String, Value>)>,
    bases: VecDeque<(String, BTreeSet<String>)>,
    bytes: HashMap<String, Arc<[u8]>>,
    order: VecDeque<String>,
    size: usize,
}

pub(crate) struct Cache {
    documents: Mutex<HashMap<String, Document>>,
    tokens: Mutex<HashMap<String, (String, String, String)>>,
    limit: Mutex<usize>,
}

impl Default for Cache {
    fn default() -> Self {
        Self { documents: Mutex::default(), tokens: Mutex::default(), limit: Mutex::new(64 * 1024 * 1024) }
    }
}

impl Cache {
    /// The latest complete model, for an outgoing session that has already closed.
    pub fn snapshot(&self, journals: &Journals, key: &str) -> Option<Map<String, Value>> {
        let revision = journals.revision(key);
        self.documents
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)?
            .snapshot
            .as_ref()
            .filter(|(basis, _)| *basis == revision)
            .map(|(_, objects)| objects.clone())
    }

    pub(crate) fn remember_snapshot(&self, key: &str, basis: &str, objects: Map<String, Value>) {
        let limit = *self.limit.lock().unwrap_or_else(PoisonError::into_inner);
        let snapshot =
            (objects.len() <= REFERENCES && serde_json::to_vec(&objects).is_ok_and(|bytes| bytes.len() <= limit)).then(|| (basis.to_owned(), objects));
        self.documents.lock().unwrap_or_else(PoisonError::into_inner).entry(key.to_owned()).or_default().snapshot = snapshot;
    }

    /// Puts back the snapshot [`Cache::snapshot`] answered for the journal's current revision
    /// (`None`: none), replacing one captured since that turned out not to be of that state.
    pub(crate) fn restore_snapshot(&self, journals: &Journals, key: &str, objects: Option<Map<String, Value>>) {
        let basis = journals.revision(key);
        self.documents.lock().unwrap_or_else(PoisonError::into_inner).entry(key.to_owned()).or_default().snapshot = objects.map(|objects| (basis, objects));
    }

    pub fn set_limit(&self, bytes: usize) {
        *self.limit.lock().unwrap_or_else(PoisonError::into_inner) = bytes;
    }

    /// Only bytes authorized for this callback's basis and named by its supplied values.
    pub(crate) fn editor_history(&self, journals: &Journals, kit: &str, token: &str, params: &Value) -> Value {
        let mut refs = BTreeMap::new();
        references(params, &mut refs);
        let mut history = Map::new();
        let mut remaining = 64 * 1024 * 1024;
        for (hash, size) in refs {
            if self.read(journals, kit, json!({"token":token,"hash":hash,"offset":0,"length":0}))["available"] != true {
                continue;
            }
            let mut bytes = Vec::new();
            while bytes.len() < size {
                let answer = self.read(journals, kit, json!({"token":token,"hash":hash,"offset":bytes.len(),"length":CHUNK.min(size-bytes.len())}));
                let Some(chunk) = answer["data"].as_str().and_then(base64::decode).filter(|chunk| !chunk.is_empty()) else { break };
                bytes.extend(chunk);
            }
            if bytes.len() == size {
                let value = json!(bytes);
                let encoded = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
                if encoded <= remaining {
                    remaining -= encoded;
                    history.insert(hash, value);
                }
            }
        }
        json!(history)
    }

    fn retain(&self, journals: &Journals, key: &str, basis: String, refs: BTreeSet<String>, captured: Vec<(String, Vec<u8>)>) {
        let limit = *self.limit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut docs = self.documents.lock().unwrap_or_else(PoisonError::into_inner);
        let doc = docs.entry(key.to_owned()).or_default();
        doc.bases.retain(|(basis, _)| matches!(journals.since(key, basis), Since::Covered(_)));
        if doc.bases.back().is_none_or(|(at, _)| *at != basis) {
            doc.bases.push_back((basis, refs));
        }
        while doc.bases.iter().map(|(_, refs)| refs.len().max(1)).sum::<usize>() > REFERENCES {
            doc.bases.pop_front();
        }
        let kept: BTreeSet<&String> = doc.bases.iter().flat_map(|(_, refs)| refs).collect();
        doc.bytes.retain(|hash, _| kept.contains(hash));
        doc.order.retain(|hash| doc.bytes.contains_key(hash));
        doc.size = doc.bytes.values().map(|bytes| bytes.len()).sum();
        for (hash, bytes) in captured {
            if bytes.len() > limit || !kept.contains(&hash) || doc.bytes.contains_key(&hash) {
                continue;
            }
            while doc.size + bytes.len() > limit {
                let Some(old) = doc.order.pop_front() else { break };
                if let Some(bytes) = doc.bytes.remove(&old) {
                    doc.size -= bytes.len();
                }
            }
            doc.size += bytes.len();
            doc.order.push_back(hash.clone());
            doc.bytes.insert(hash, bytes.into());
        }
    }

    pub fn grant(self: &Arc<Self>, kit: &str, key: &str, basis: &str) -> Grant {
        let token = format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>());
        self.tokens.lock().unwrap_or_else(PoisonError::into_inner).insert(token.clone(), (kit.to_owned(), key.to_owned(), basis.to_owned()));
        Grant { cache: Arc::clone(self), token }
    }

    fn read(&self, journals: &Journals, kit: &str, params: Value) -> Value {
        let unavailable = |reason| json!({"available": false, "reason": reason});
        let token = params["token"].as_str().unwrap_or_default();
        let Some((owner, key, basis)) = self.tokens.lock().unwrap_or_else(PoisonError::into_inner).get(token).cloned() else {
            return unavailable("invalid-token");
        };
        if owner != kit {
            return unavailable("invalid-token");
        }
        if !matches!(journals.since(&key, &basis), Since::Covered(_)) {
            return unavailable("basis-expired");
        }
        let hash = params["hash"].as_str().unwrap_or_default();
        let docs = self.documents.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(doc) = docs.get(&key) else { return unavailable("unsupported") };
        let Some((_, refs)) = doc.bases.iter().find(|(at, _)| *at == basis) else { return unavailable("capture-unavailable") };
        if !refs.contains(hash) {
            return unavailable("not-at-basis");
        }
        let Some(bytes) = doc.bytes.get(hash) else { return unavailable("bytes-unavailable") };
        let Some(offset) = params["offset"].as_u64().and_then(|n| usize::try_from(n).ok()) else { return unavailable("invalid-range") };
        let Some(length) = params["length"].as_u64().and_then(|n| usize::try_from(n).ok()).filter(|n| *n <= CHUNK) else { return unavailable("invalid-range") };
        if offset > bytes.len() {
            return unavailable("invalid-range");
        }
        json!({"available":true,"hash":hash,"size":bytes.len(),"data":base64::encode(&bytes[offset..offset.saturating_add(length).min(bytes.len())])})
    }
}

pub(crate) struct Grant {
    cache: Arc<Cache>,
    pub token: String,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.cache.tokens.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.token);
    }
}

tokio::task_local! { pub static TOKEN: String; }

pub(crate) struct Services {
    pub files: Arc<KitFiles>,
    pub journals: Arc<Journals>,
    pub cache: Arc<Cache>,
    pub kit: &'static str,
}
impl HostService for Services {
    fn services(&self) -> Vec<String> {
        let mut services = self.files.services();
        services.push("history.blob.read".into());
        services
    }
    fn serve(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if method == "history.blob.read" { Ok(self.cache.read(&self.journals, self.kit, params)) } else { self.files.serve(method, params) }
    }
}

fn references(value: &Value, refs: &mut BTreeMap<String, usize>) {
    match value {
        Value::Object(map) => {
            if let (Some(hash), Some(size)) = (map.get("hash").and_then(Value::as_str), map.get("size").and_then(Value::as_u64))
                && hash.len() == 64
                && hash.bytes().all(|b| b.is_ascii_hexdigit())
                && let Ok(size) = usize::try_from(size)
            {
                refs.insert(hash.to_owned(), size);
            }
            for value in map.values() {
                references(value, refs);
            }
        }
        Value::Array(items) => {
            for value in items {
                references(value, refs);
            }
        }
        _ => {}
    }
}

/// Capture from the outgoing session, never from the file that may already be replaced.
pub(crate) async fn capture(kits: &KitManager, key: &str, view: &DocumentView) {
    capture_from(kits, key, super::guard::Reader::Kit(view)).await;
}

pub(crate) async fn capture_from(kits: &KitManager, key: &str, reader: super::guard::Reader<'_>) {
    let Some(described) = reader.described(kits).await else { return };
    let Some(objects) = super::guard::objects_from(kits, reader).await else { return };
    let basis = kits.inner.journals.revision(key);
    kits.inner.history.remember_snapshot(key, &basis, objects.clone());
    if described["blobBytes"] != true {
        return;
    }
    let mut refs = BTreeMap::new();
    for object in objects.values() {
        references(object, &mut refs);
    }
    let limit = *kits.inner.history.limit.lock().unwrap_or_else(PoisonError::into_inner);
    let mut captured = Vec::new();
    let mut captured_size = 0;
    for (hash, size) in &refs {
        if *size > limit.saturating_sub(captured_size) {
            continue;
        }
        let cached = kits.inner.history.documents.lock().unwrap_or_else(PoisonError::into_inner).get(key).is_some_and(|doc| doc.bytes.contains_key(hash));
        if cached {
            continue;
        }
        let mut bytes = Vec::with_capacity(*size);
        while bytes.len() < *size {
            let params = json!({"hash":hash,"offset":bytes.len(),"length":CHUNK.min(*size-bytes.len())});
            let Some(answer) = reader.model(kits, "model.blob.read", params).await else {
                break;
            };
            if answer["available"] != true || answer["size"].as_u64() != Some(*size as u64) {
                break;
            }
            let Some(chunk) = answer["data"]
                .as_str()
                .and_then(base64::decode)
                .or_else(|| serde_json::from_value::<Vec<u8>>(answer["data"].clone()).ok())
                .filter(|b| !b.is_empty() && b.len() <= CHUNK.min(*size - bytes.len()))
            else {
                break;
            };
            bytes.extend(chunk);
        }
        if bytes.len() == *size && hex::encode(Sha256::digest(&bytes)) == *hash {
            captured_size += bytes.len();
            captured.push((hash.clone(), bytes));
        }
    }
    kits.inner.history.retain(&kits.inner.journals, key, basis, refs.into_keys().collect(), captured);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_session_checkpoint_is_bounded_and_matches_only_the_current_revision() {
        let journals = Journals::default();
        let cache = Cache::default();
        cache.set_limit(64);
        let basis = journals.revision("d");
        let objects = Map::from_iter([("root".into(), json!({"name":"Tile"}))]);
        cache.remember_snapshot("d", &basis, objects.clone());
        assert_eq!(cache.snapshot(&journals, "d"), Some(objects.clone()));
        journals.append("d", "other", None);
        assert!(cache.snapshot(&journals, "d").is_none());
        cache.set_limit(1);
        cache.remember_snapshot("d", &journals.revision("d"), objects);
        assert!(cache.snapshot(&journals, "d").is_none());
    }

    #[test]
    fn historical_bytes_are_scoped_bounded_revocable_and_journal_bounded() {
        let journals = Journals::default();
        let cache = Arc::new(Cache::default());
        cache.set_limit(4);
        let basis = journals.revision("d");
        cache.retain(&journals, "d", basis.clone(), BTreeSet::from(["h".into()]), vec![("h".into(), vec![1, 2, 3, 4])]);
        let grant = cache.grant("kit", "d", &basis);
        let ask = json!({"token":grant.token,"hash":"h","offset":1,"length":2});
        assert_eq!(cache.read(&journals, "kit", ask.clone())["data"], base64::encode(&[2, 3]));
        assert_eq!(cache.read(&journals, "other", ask.clone())["available"], false);
        let mut wrong = ask.clone();
        wrong["hash"] = json!("elsewhere");
        assert_eq!(cache.read(&journals, "kit", wrong)["reason"], "not-at-basis");
        let next = journals.append("d", "other", None);
        cache.retain(&journals, "d", next, BTreeSet::from(["new".into()]), vec![("new".into(), vec![5, 6, 7, 8])]);
        assert_eq!(cache.read(&journals, "kit", ask.clone())["reason"], "bytes-unavailable");
        journals.set_limits(1, 1);
        journals.append("d", "other", None);
        assert_eq!(cache.read(&journals, "kit", ask.clone())["reason"], "basis-expired");
        drop(grant);
        assert_eq!(cache.read(&journals, "kit", ask)["reason"], "invalid-token");
    }
}
