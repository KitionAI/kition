// Copied from kition-sdk crates/kition-license/tests/vectors.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The licence test vectors (`tests/vectors.json`), which `@kition/license` also checks: keys
//! signed with an obviously fake test seed, and what each must verify to. The file is generated
//! here; `KITION_LICENSE_WRITE_VECTORS=1 cargo test -p kition-license` rewrites it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use kition_license::{Context, Form, Kits, License, PublicKey, is_development_origin, is_tenant, origin_matches, verify};
use serde_json::{Value, json};

/// Test seeds, never production keys.
const TEST_SEED: [u8; 32] = [7; 32];
const OTHER_SEED: [u8; 32] = [9; 32];
const NOW: u64 = 1_800_000_000;
const DAY: u64 = 86_400;

fn license() -> License {
    License {
        v: 1,
        kid: "test-1".into(),
        licensee: "Example Corp (test)".into(),
        kits: Kits::All("*".into()),
        forms: vec!["embed".into(), "script".into(), "headless".into(), "mcp".into()],
        tenant: None,
        origins: vec!["https://app.example.com".into(), "https://*.example.org".into()],
        app_ids: vec![],
        issued: NOW - DAY,
        expires: NOW + 365 * DAY,
        seats: None,
        notes: None,
    }
}

/// Signs `payload` with its keys sorted, as Console writes them (whatever serde_json's
/// `preserve_order` feature is in the workspace).
fn sign_json(payload: &Value, seed: &[u8; 32]) -> String {
    let sorted: std::collections::BTreeMap<String, Value> = serde_json::from_value(payload.clone()).unwrap();
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&sorted).unwrap());
    let signature = SigningKey::from_bytes(seed).sign(payload.as_bytes());
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

fn sign(license: &License) -> String {
    sign_json(&serde_json::to_value(license).unwrap(), &TEST_SEED)
}

fn keys() -> Vec<PublicKey> {
    vec![PublicKey { kid: "test-1", key: SigningKey::from_bytes(&TEST_SEED).verifying_key().to_bytes() }]
}

struct Case {
    name: &'static str,
    token: String,
    kit: Option<&'static str>,
    form: Form,
    origin: Option<&'static str>,
    app_id: Option<&'static str>,
    error: Option<&'static str>,
}

fn case(name: &'static str, token: String, kit: Option<&'static str>, form: Form, origin: Option<&'static str>, error: Option<&'static str>) -> Case {
    Case { name, token, kit, form, origin, app_id: None, error }
}

fn cases() -> Vec<Case> {
    let valid = sign(&license());
    let (payload, _) = valid.split_once('.').unwrap();
    let mut other = license();
    other.licensee = "Someone Else (test)".into();
    let other = sign(&other);
    let (_, other_signature) = other.split_once('.').unwrap();
    let mut expired = license();
    expired.expires = NOW;
    let mut sheet_only = license();
    sheet_only.kits = Kits::Only(vec!["kit.sheet".into()]);
    let mut embed_only = license();
    embed_only.forms = vec!["embed".into()];
    let mut unknown = license();
    unknown.kid = "test-2".into();
    let mut v2 = serde_json::to_value(license()).unwrap();
    v2["v"] = json!(2);
    let mut bad_kits = serde_json::to_value(license()).unwrap();
    bad_kits["kits"] = json!("all");
    let mut apps = license();
    apps.app_ids = vec!["com.example.agent".into()];
    let mut no_origins = license();
    no_origins.origins = vec![];
    let mut collab = license();
    collab.forms = vec!["collab".into(), "selfhost".into()];
    collab.tenant = Some("example-corp".into());
    collab.app_ids = vec!["com.example.agent".into()];
    let mut no_tenant = collab.clone();
    no_tenant.tenant = None;
    let mut bad_tenant = collab.clone();
    bad_tenant.tenant = Some("Example_Corp".into());
    vec![
        case("embed on a listed origin", valid.clone(), Some("kit.slide"), Form::Embed, Some("https://app.example.com"), None),
        case("embed on a wildcard subdomain", valid.clone(), Some("kit.sheet"), Form::Embed, Some("https://a.b.example.org"), None),
        case("embed on the wildcard's apex", valid.clone(), Some("kit.sheet"), Form::Embed, Some("https://example.org"), Some("origin")),
        case("embed on another origin", valid.clone(), Some("kit.slide"), Form::Embed, Some("https://evil.example.net"), Some("origin")),
        case("embed on another scheme", valid.clone(), Some("kit.slide"), Form::Embed, Some("http://app.example.com"), Some("origin")),
        case("embed without origins in the licence", sign(&no_origins), Some("kit.slide"), Form::Embed, Some("https://app.example.com"), Some("origin")),
        case("mcp at a server's start", valid.clone(), None, Form::Mcp, None, None),
        case("expired", sign(&expired), Some("kit.slide"), Form::Mcp, None, Some("expired")),
        case("kit not covered", sign(&sheet_only), Some("kit.slide"), Form::Headless, None, Some("kit")),
        case("form not covered", sign(&embed_only), Some("kit.slide"), Form::Mcp, None, Some("form")),
        case("unknown key id", sign(&unknown), Some("kit.slide"), Form::Mcp, None, Some("unknown-key")),
        case("signed by another key", sign_json(&serde_json::to_value(license()).unwrap(), &OTHER_SEED), Some("kit.slide"), Form::Mcp, None, Some("signature")),
        case("payload swapped under a signature", format!("{payload}.{other_signature}"), Some("kit.slide"), Form::Mcp, None, Some("signature")),
        case("not a key", "abc".into(), Some("kit.slide"), Form::Mcp, None, Some("malformed")),
        case("three segments", format!("{valid}.x"), Some("kit.slide"), Form::Mcp, None, Some("malformed")),
        case("payload version 2", sign_json(&v2, &TEST_SEED), Some("kit.slide"), Form::Mcp, None, Some("version")),
        case("kits neither a list nor *", sign_json(&bad_kits, &TEST_SEED), Some("kit.slide"), Form::Mcp, None, Some("malformed")),
        case("application id required", sign(&apps), Some("kit.slide"), Form::Mcp, None, Some("app")),
        Case { app_id: Some("com.example.agent"), ..case("application id given", sign(&apps), Some("kit.slide"), Form::Script, None, None) },
        Case { app_id: Some("com.example.other"), ..case("another application id", sign(&apps), Some("kit.slide"), Form::Script, None, Some("app")) },
        case("collab for its tenant", sign(&collab), None, Form::Collab, None, None),
        case("selfhost for its tenant, application ids aside", sign(&collab), None, Form::Selfhost, None, None),
        case("collab not covered", valid.clone(), None, Form::Collab, None, Some("form")),
        case("collab without a tenant", sign(&no_tenant), None, Form::Collab, None, Some("tenant")),
        case("selfhost with an invalid tenant", sign(&bad_tenant), None, Form::Selfhost, None, Some("tenant")),
    ]
}

const ORIGINS: &[(&str, &str, bool)] = &[
    ("https://app.example.com", "https://app.example.com", true),
    ("https://app.example.com/", "https://APP.example.com", true),
    ("https://app.example.com", "https://app.example.com:8443", false),
    ("https://*.example.com", "https://x.example.com", true),
    ("https://*.example.com", "https://x.y.example.com", true),
    ("https://*.example.com", "https://example.com", false),
    ("https://*.example.com", "https://xexample.com", false),
    ("https://*.example.com:8443", "https://x.example.com:8443", true),
    ("https://*.example.com:8443", "https://x.example.com", false),
    ("https://*.example.com", "http://x.example.com", false),
];

const DEVELOPMENT: &[(&str, bool)] = &[
    ("http://localhost:5173", true),
    ("https://localhost", true),
    ("http://app.localhost:3000", true),
    ("http://127.0.0.1:8080", true),
    ("http://127.10.0.3", true),
    ("http://[::1]:4000", true),
    ("null", true),
    ("file://", true),
    ("https://app.example.com", false),
    ("http://localhost.example.com", false),
    ("http://127.0.0.1.example.com", false),
    ("http://10.0.0.1", false),
];

const TENANTS: &[(&str, bool)] = &[
    ("acme", true),
    ("example-corp", true),
    ("a1", true),
    ("a", false),
    ("-acme", false),
    ("acme-", false),
    ("Acme", false),
    ("acme_corp", false),
    ("acme.corp", false),
    ("abcdefghijabcdefghijabcdefghijabcdefghij", true),
    ("abcdefghijabcdefghijabcdefghijabcdefghijk", false),
];

fn vectors() -> Value {
    let keys = keys();
    let cases: Vec<Value> = cases()
        .into_iter()
        .map(|case| {
            let context = Context { kit: case.kit, form: case.form, origin: case.origin, app_id: case.app_id, now: NOW };
            let got = verify(&case.token, &keys, &context);
            assert_eq!(got.as_ref().err().map(|error| error.code()), case.error, "{}", case.name);
            json!({
                "name": case.name,
                "token": case.token,
                "context": { "kit": case.kit, "form": case.form.as_str(), "origin": case.origin, "appId": case.app_id, "now": NOW },
                "error": case.error,
                "licensee": got.ok().map(|license| license.licensee),
            })
        })
        .collect();
    for (pattern, origin, expected) in ORIGINS {
        assert_eq!(origin_matches(pattern, origin), *expected, "{pattern} vs {origin}");
    }
    for (origin, expected) in DEVELOPMENT {
        assert_eq!(is_development_origin(origin), *expected, "{origin}");
    }
    for (tenant, expected) in TENANTS {
        assert_eq!(is_tenant(tenant), *expected, "{tenant}");
    }
    json!({
        "note": "Generated by crates/kition-license/tests/vectors.rs with fake test seeds; never a production key.",
        "keys": keys.iter().map(|key| json!({ "kid": key.kid, "key": URL_SAFE_NO_PAD.encode(key.key) })).collect::<Vec<_>>(),
        "cases": cases,
        "origins": ORIGINS.iter().map(|(pattern, origin, matches)| json!({ "pattern": pattern, "origin": origin, "matches": matches })).collect::<Vec<_>>(),
        "development": DEVELOPMENT.iter().map(|(origin, development)| json!({ "origin": origin, "development": development })).collect::<Vec<_>>(),
        "tenants": TENANTS.iter().map(|(tenant, valid)| json!({ "tenant": tenant, "valid": valid })).collect::<Vec<_>>(),
    })
}

/// `value` with every object's keys sorted, so the file is the same with or without serde_json's
/// `preserve_order` feature.
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<String, Value> = map.into_iter().map(|(key, value)| (key, canonical(value))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        other => other,
    }
}

#[test]
fn vectors_match_the_committed_file() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors.json");
    let generated = serde_json::to_string_pretty(&canonical(vectors())).unwrap() + "\n";
    if std::env::var_os("KITION_LICENSE_WRITE_VECTORS").is_some() {
        std::fs::write(&path, &generated).unwrap();
    }
    let committed = std::fs::read_to_string(&path).expect("tests/vectors.json: run with KITION_LICENSE_WRITE_VECTORS=1");
    assert_eq!(committed, generated, "tests/vectors.json is stale: run with KITION_LICENSE_WRITE_VECTORS=1");
}

#[test]
fn the_pinned_keys_are_valid_ed25519_keys() {
    for key in kition_license::PINNED_KEYS {
        assert!(ed25519_dalek::VerifyingKey::from_bytes(&key.key).is_ok(), "{}", key.kid);
    }
}

#[test]
fn decode_reads_a_key_without_verifying_it() {
    let token = sign(&license());
    assert_eq!(kition_license::decode(&token).unwrap().licensee, "Example Corp (test)");
}
