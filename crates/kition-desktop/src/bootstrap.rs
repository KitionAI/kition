//! Launch verification for official builds: a short-lived challenge, then
//! device and installation registration.

use axum::response::{IntoResponse, Response};
use kition_core::{AppError, AppResult, Millis, now_millis};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::body::Body;

const CHALLENGE_TTL_MS: i64 = 2 * 60_000;
const RATE_WINDOW_MS: i64 = 2 * 60_000;
const RATE_LIMIT: i64 = 6;

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostics {
    pub code: &'static str,
    pub title: &'static str,
    pub message: &'static str,
    pub detail: &'static str,
    pub support_id: String,
    pub retryable: bool,
    pub next_action: &'static str,
}

#[allow(clippy::too_many_arguments)]
fn diagnostics(
    code: &'static str,
    title: &'static str,
    message: &'static str,
    detail: &'static str,
    support_id: &str,
    retryable: bool,
    next_action: &'static str,
) -> Diagnostics {
    Diagnostics {
        code,
        title,
        message,
        detail,
        support_id: support_id.to_owned(),
        retryable,
        next_action,
    }
}

fn failure(status: u16, message: &str, data: Value) -> Response {
    AppError::new(status, i64::from(status), message)
        .with_data(data)
        .into_response()
}

#[derive(Debug, Default, Serialize)]
pub struct ChallengeRequest {
    pub startup_id: String,
    pub official_build: bool,
    pub build_channel: String,
    pub platform: String,
    pub app_version: String,
    pub build_version: String,
    pub build_commit: String,
    pub installation_id: String,
}

impl ChallengeRequest {
    fn read(body: &mut Body) -> Self {
        Self {
            startup_id: body.required("startup_id"),
            official_build: body.boolean("official_build"),
            build_channel: body.required("build_channel"),
            platform: body.required("platform"),
            app_version: body.required("app_version"),
            build_version: body.string("build_version"),
            build_commit: body.string("build_commit"),
            installation_id: body.required("installation_id"),
        }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct CompleteRequest {
    pub startup_id: String,
    pub challenge_id: String,
    pub official_build: bool,
    pub build_channel: String,
    pub platform: String,
    pub runtime: Value,
    pub installation: Value,
    pub attestation: Value,
    #[serde(skip)]
    pub app_version: String,
    #[serde(skip)]
    pub os_version: String,
    #[serde(skip)]
    pub arch: String,
    #[serde(skip)]
    pub hostname_hash: String,
    #[serde(skip)]
    pub installation_id: String,
    #[serde(skip)]
    pub installation_proof: String,
    #[serde(skip)]
    pub sequence: i64,
    #[serde(skip)]
    pub packaged: bool,
    #[serde(skip)]
    pub hardware_uuid_hash: String,
    #[serde(skip)]
    pub serial_hash: String,
    #[serde(skip)]
    pub board_serial_hash: String,
    #[serde(skip)]
    pub mac_hashes: Vec<String>,
}

impl CompleteRequest {
    fn read(body: &mut Body) -> Self {
        let mut req = Self {
            startup_id: body.required("startup_id"),
            challenge_id: body.required("challenge_id"),
            official_build: body.boolean("official_build"),
            build_channel: body.required("build_channel"),
            platform: body.required("platform"),
            app_version: body.required("runtime.app_version"),
            os_version: body.string("runtime.os_version"),
            arch: body.required("runtime.arch"),
            hostname_hash: body.string("runtime.hostname_hash"),
            installation_id: body.required("installation.installation_id"),
            installation_proof: body.required("installation.installation_proof"),
            sequence: body.integer("installation.sequence"),
            packaged: body.boolean("attestation.integrity.packaged"),
            hardware_uuid_hash: body.required("attestation.hardware.hardware_uuid_hash"),
            serial_hash: body.string("attestation.hardware.serial_hash"),
            board_serial_hash: body.string("attestation.hardware.board_serial_hash"),
            mac_hashes: body.strings("attestation.hardware.mac_hashes"),
            ..Default::default()
        };
        body.string("runtime.build_version");
        body.string("runtime.build_commit");
        body.required("attestation.schema_version");
        body.required("attestation.module_version");
        body.boolean("attestation.integrity.signature_present");
        body.boolean("attestation.integrity.debugger_detected");
        body.strings("attestation.integrity.tamper_flags");
        body.required("attestation.proof.challenge_binding");
        body.required("attestation.proof.attestation_signature");
        req.runtime = json!({"app_version": req.app_version, "os_version": req.os_version, "arch": req.arch, "hostname_hash": req.hostname_hash});
        req.installation =
            json!({"installation_id": req.installation_id, "sequence": req.sequence});
        req.attestation = json!({"integrity": {"packaged": req.packaged}});
        req
    }
}

fn not_official(
    req_official: bool,
    channel: &str,
    startup_id: &str,
    support_id: &str,
    message: &'static str,
) -> Response {
    failure(
        403,
        "This build does not meet the official launch requirements",
        json!({
            "official_build": req_official,
            "build_channel": channel,
            "startup_id": startup_id,
            "diagnostics": diagnostics(
                "BOOTSTRAP_OFFICIAL_REQUIRED",
                "Official launch verification is not enabled in this build",
                message,
                "Please use an official build, or switch to manual Provider configuration.",
                support_id,
                false,
                "manual_provider_setup",
            ),
        }),
    )
}

pub(crate) fn short_hash(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    format!(
        "sha256:{}",
        hex::encode(&Sha256::digest(value.as_bytes())[..8])
    )
}

fn rate_limited(conn: &Connection, installation_id: &str, platform: &str, now: Millis) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM desktop_bootstrap_events WHERE installation_id = ?1 AND platform = ?2 AND created_at >= ?3",
        params![installation_id.trim(), platform.trim(), now - RATE_WINDOW_MS],
        |r| r.get::<_, i64>(0),
    )
    .map(|count| count >= RATE_LIMIT)
    .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn record_event(
    conn: &Connection,
    event_type: &str,
    outcome: &str,
    startup_id: &str,
    challenge_id: &str,
    installation_id: &str,
    device_id: &str,
    platform: &str,
    build_channel: &str,
    support_id: &str,
    request: &impl Serialize,
    response: &Value,
) {
    let request = serde_json::to_string(request).unwrap_or_else(|_| "null".into());
    let result = conn.execute(
        "INSERT INTO desktop_bootstrap_events (startup_id, challenge_id, installation_id, device_id, platform, build_channel, \
         event_type, outcome, support_id, request_data, response_data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            startup_id.trim(),
            challenge_id.trim(),
            installation_id.trim(),
            device_id.trim(),
            platform.trim(),
            build_channel.trim(),
            event_type,
            outcome,
            support_id,
            request,
            response.to_string(),
            now_millis()
        ],
    );
    if let Err(err) = result {
        tracing::warn!(error = %err, "failed to record a launch verification event");
    }
}

pub(crate) fn challenge(conn: &Connection, raw: &[u8], support_id: &str) -> AppResult<Response> {
    let mut body = Body::parse(raw);
    let req = ChallengeRequest::read(&mut body);
    if !body.ok() {
        return Err(AppError::localized_bad_request("common.bad_request"));
    }
    if req.build_channel.trim() != "official" || !req.official_build {
        return Ok(not_official(
            req.official_build,
            &req.build_channel,
            &req.startup_id,
            support_id,
            "This build does not meet the official launch requirements and cannot request official verification.",
        ));
    }
    let now = now_millis();
    if rate_limited(conn, &req.installation_id, &req.platform, now) {
        return Ok(failure(
            429,
            "Too many launch verification attempts; please retry later",
            json!({
                "official_build": req.official_build,
                "build_channel": req.build_channel,
                "startup_id": req.startup_id,
                "diagnostics": diagnostics(
                    "BOOTSTRAP_RATE_LIMITED",
                    "Too many launch verification attempts",
                    "This device has hit the launch verification rate limit; please try again later.",
                    "If the same issue persists, copy the support information and contact technical support.",
                    support_id,
                    true,
                    "retry_later",
                ),
            }),
        ));
    }
    let challenge_id = format!("chl_{}", uuid::Uuid::new_v4());
    let challenge = format!("bts_{}", uuid::Uuid::new_v4());
    let expires_at = now + CHALLENGE_TTL_MS;
    conn.execute(
        "INSERT INTO desktop_bootstrap_challenges (challenge_id, startup_id, installation_id, platform, build_channel, official_build, \
         challenge, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            challenge_id,
            req.startup_id.trim(),
            req.installation_id.trim(),
            req.platform.trim(),
            req.build_channel.trim(),
            req.official_build,
            challenge,
            expires_at,
            now
        ],
    )
    .map_err(|_| AppError::internal("Failed to create launch challenge"))?;
    record_event(
        conn,
        "challenge",
        "issued",
        &req.startup_id,
        &challenge_id,
        &req.installation_id,
        "",
        &req.platform,
        &req.build_channel,
        support_id,
        &req,
        &json!({"challenge_id": challenge_id, "expires_at": expires_at}),
    );
    Ok(kition_http::ok(json!({
        "official_build": req.official_build,
        "build_channel": req.build_channel,
        "startup_id": req.startup_id,
        "challenge_id": challenge_id,
        "challenge": challenge,
        "expires_at": expires_at,
        "server_time": now_millis(),
        "bootstrap_policy": {
            "official_required": true,
            "blocked_on_failure": true,
            "retry_allowed": true,
            "max_attempts_hint": 3,
        },
        "diagnostics": diagnostics(
            "BOOTSTRAP_CHALLENGE_ISSUED",
            "Preparing launch verification",
            "This device is requesting launch verification; please wait.",
            "",
            support_id,
            true,
            "continue",
        ),
    })))
}

/// Finds a device by hardware UUID, then by serial numbers, or creates one.
fn find_or_create_device(
    conn: &Connection,
    req: &CompleteRequest,
    now: Millis,
) -> rusqlite::Result<(String, &'static str, bool)> {
    let macs = serde_json::to_string(&req.mac_hashes).unwrap_or_else(|_| "null".into());
    let serial = req.serial_hash.trim();
    let board = req.board_serial_hash.trim();
    let hardware = req.hardware_uuid_hash.trim();
    let by_hardware: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT id, device_id, COALESCE(upstream_token, '') FROM desktop_bootstrap_devices WHERE hardware_uuid_hash = ?1 ORDER BY id LIMIT 1",
            [hardware],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let existing = match by_hardware {
        Some(found) => Some(found),
        None if !serial.is_empty() || !board.is_empty() => {
            let (sql, args): (&str, Vec<&str>) = if board.is_empty() {
                (
                    "SELECT id, device_id, COALESCE(upstream_token, '') FROM desktop_bootstrap_devices \
                     WHERE serial_hash = ?1 AND serial_hash <> '' ORDER BY id LIMIT 1",
                    vec![serial],
                )
            } else {
                (
                    "SELECT id, device_id, COALESCE(upstream_token, '') FROM desktop_bootstrap_devices \
                     WHERE (serial_hash = ?1 AND serial_hash <> '') OR (board_serial_hash = ?2 AND board_serial_hash <> '') ORDER BY id LIMIT 1",
                    vec![serial, board],
                )
            };
            conn.query_row(sql, rusqlite::params_from_iter(args), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?
        }
        None => None,
    };
    if let Some((id, device_id, upstream_token)) = existing {
        conn.execute(
            "UPDATE desktop_bootstrap_devices SET hardware_uuid_hash = ?1, serial_hash = ?2, board_serial_hash = ?3, mac_hashes = ?4, \
             last_seen_at = ?5, updated_at = ?5 WHERE id = ?6",
            params![hardware, serial, board, macs, now, id],
        )?;
        return Ok((
            device_id,
            "existing_device",
            !upstream_token.trim().is_empty(),
        ));
    }
    let device_id = format!("dev_{}", uuid::Uuid::new_v4());
    let extra = json!({"runtime": {"os_version": req.os_version, "arch": req.arch}}).to_string();
    conn.execute(
        "INSERT INTO desktop_bootstrap_devices (device_id, platform, hardware_uuid_hash, serial_hash, board_serial_hash, mac_hashes, \
         risk_status, risk_score, last_seen_at, extra_data, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'trusted', 0, ?7, ?8, ?7, ?7)",
        params![device_id, req.platform.trim(), hardware, serial, board, macs, now, extra],
    )?;
    Ok((device_id, "new_device", false))
}

fn upsert_installation(
    conn: &Connection,
    req: &CompleteRequest,
    device_id: &str,
    support_id: &str,
    status: &str,
    now: Millis,
) -> rusqlite::Result<&'static str> {
    let extra = json!({
        "sequence": req.sequence,
        "hostname_hash": req.hostname_hash,
        "installation_proof": short_hash(&req.installation_proof),
    })
    .to_string();
    let installation_id = req.installation_id.trim();
    let updated = conn.execute(
        "UPDATE desktop_bootstrap_installations SET device_id = ?1, platform = ?2, official_build = ?3, build_channel = ?4, \
         app_version = ?5, last_startup_id = ?6, last_challenge_id = ?7, last_support_id = ?8, last_bootstrap_status = ?9, \
         last_seen_at = ?10, extra_data = ?11, updated_at = ?10 WHERE installation_id = ?12",
        params![
            device_id,
            req.platform,
            req.official_build,
            req.build_channel,
            req.app_version,
            req.startup_id,
            req.challenge_id,
            support_id,
            status,
            now,
            extra,
            installation_id
        ],
    )?;
    if updated > 0 {
        return Ok("existing_installation");
    }
    conn.execute(
        "INSERT INTO desktop_bootstrap_installations (installation_id, device_id, platform, official_build, build_channel, app_version, \
         last_startup_id, last_challenge_id, last_bootstrap_status, last_support_id, first_seen_at, last_seen_at, extra_data, \
         created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?11, ?11)",
        params![
            installation_id,
            device_id,
            req.platform,
            req.official_build,
            req.build_channel,
            req.app_version,
            req.startup_id,
            req.challenge_id,
            status,
            support_id,
            now,
            extra
        ],
    )?;
    Ok("new_installation")
}

pub(crate) fn complete(conn: &Connection, raw: &[u8], support_id: &str) -> AppResult<Response> {
    let mut body = Body::parse(raw);
    let req = CompleteRequest::read(&mut body);
    let echo = |extra: Value| {
        let mut data = json!({
            "official_build": req.official_build,
            "build_channel": req.build_channel,
            "startup_id": req.startup_id,
        });
        if let (Some(map), Value::Object(extra)) = (data.as_object_mut(), extra) {
            map.extend(extra);
        }
        data
    };
    if !body.ok() {
        return Ok(failure(
            400,
            "Invalid launch verification request",
            echo(json!({"diagnostics": diagnostics(
                "BOOTSTRAP_BAD_REQUEST",
                "Invalid launch verification request",
                "The launch verification request is missing required fields; the official build cannot continue starting up.",
                "Please retry launch verification; if the issue persists, contact technical support.",
                support_id,
                true,
                "retry",
            )})),
        ));
    }
    if req.build_channel.trim() != "official" || !req.official_build {
        return Ok(not_official(
            req.official_build,
            &req.build_channel,
            &req.startup_id,
            support_id,
            "This build does not meet the official launch requirements and cannot complete verification.",
        ));
    }
    let now = now_millis();
    let challenge: Option<(i64, Option<i64>, i64)> = conn
        .query_row(
            "SELECT id, consumed_at, COALESCE(expires_at, 0) FROM desktop_bootstrap_challenges \
             WHERE challenge_id = ?1 AND startup_id = ?2 AND installation_id = ?3 ORDER BY id LIMIT 1",
            params![req.challenge_id.trim(), req.startup_id.trim(), req.installation_id.trim()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((challenge_row, None, _)) = challenge.filter(|(_, _, expires_at)| now <= *expires_at)
    else {
        return Ok(failure(
            401,
            "Launch verification expired; please retry",
            echo(json!({"diagnostics": diagnostics(
                "BOOTSTRAP_DENIED_REPLAY",
                "This launch verification is no longer valid",
                "This launch request did not pass verification; the official build cannot continue into Kition right now.",
                "Please retry launch verification; if the same issue recurs, contact technical support.",
                support_id,
                true,
                "retry",
            )})),
        ));
    };
    if req.hardware_uuid_hash.trim().is_empty() || !req.packaged {
        return Ok(failure(
            403,
            "This device cannot complete launch verification right now",
            echo(json!({
                "provider": null,
                "device": {"canonical_status": "risk_review", "installation_status": "new_installation"},
                "diagnostics": diagnostics(
                    "BOOTSTRAP_DENIED_RISK",
                    "This device cannot complete launch verification right now",
                    "The official build requires device verification first; the current request was blocked and cannot enter Kition right now.",
                    "Please retry later, or copy the support information and contact technical support.",
                    support_id,
                    true,
                    "retry_or_contact_support",
                ),
            })),
        ));
    }
    let (device_id, canonical_status, reused) = find_or_create_device(conn, &req, now)
        .map_err(|_| AppError::internal("Failed to match device"))?;
    let bootstrap_status = if reused { "reused" } else { "registered" };
    let installation_status =
        upsert_installation(conn, &req, &device_id, support_id, bootstrap_status, now)
            .map_err(|_| AppError::internal("Failed to save installation information"))?;
    if let Err(err) = conn.execute(
        "UPDATE desktop_bootstrap_challenges SET consumed_at = ?1 WHERE id = ?2",
        params![now, challenge_row],
    ) {
        tracing::warn!(error = %err, "failed to consume a launch challenge");
    }
    let (code, title, message) = if reused {
        (
            "BOOTSTRAP_REUSED",
            "This device has passed launch verification",
            "Reusing this device's launch credentials and entering Kition.",
        )
    } else {
        (
            "BOOTSTRAP_REGISTERED",
            "Device initialization complete",
            "This device has completed launch verification and is entering Kition.",
        )
    };
    let response = echo(json!({
        "bootstrap_status": bootstrap_status,
        "startup_mode": "allowed",
        "provider": null,
        "device": {"canonical_status": canonical_status, "installation_status": installation_status},
        "diagnostics": diagnostics(code, title, message, "", support_id, false, "continue"),
    }));
    record_event(
        conn,
        "complete",
        bootstrap_status,
        &req.startup_id,
        &req.challenge_id,
        &req.installation_id,
        &device_id,
        &req.platform,
        &req.build_channel,
        support_id,
        &req,
        &response,
    );
    Ok(kition_http::ok(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_store::Db;

    fn complete_body(challenge_id: &str, hardware: &str) -> Vec<u8> {
        json!({
            "startup_id": "s1", "challenge_id": challenge_id, "official_build": true, "build_channel": "official", "platform": "darwin",
            "runtime": {"app_version": "1", "arch": "arm64"},
            "installation": {"installation_id": "i1", "installation_proof": "proof", "sequence": 2},
            "attestation": {"schema_version": "1", "module_version": "1",
                "integrity": {"packaged": true},
                "hardware": {"hardware_uuid_hash": hardware, "mac_hashes": ["m"]},
                "proof": {"challenge_binding": "b", "attestation_signature": "sig"}}
        })
        .to_string()
        .into_bytes()
    }

    fn status_of(response: Response) -> u16 {
        response.status().as_u16()
    }

    #[tokio::test]
    async fn issues_and_consumes_challenges() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let request = json!({"startup_id": "s1", "official_build": true, "build_channel": "official", "platform": "darwin",
            "app_version": "1", "installation_id": "i1"});
        let issued = challenge(&conn, request.to_string().as_bytes(), "trace")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(status_of(issued), 200);
        let challenge_id: String = conn
            .query_row(
                "SELECT challenge_id FROM desktop_bootstrap_challenges",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();

        let first = complete(&conn, &complete_body(&challenge_id, "hw"), "trace")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(status_of(first), 200);
        let replay = complete(&conn, &complete_body(&challenge_id, "hw"), "trace")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(status_of(replay), 401);
        let devices: i64 = conn
            .query_row("SELECT COUNT(*) FROM desktop_bootstrap_devices", [], |r| {
                r.get(0)
            })
            .unwrap_or_default();
        assert_eq!(devices, 1);

        let unofficial = json!({"startup_id": "s", "official_build": false, "build_channel": "dev", "platform": "p",
            "app_version": "1", "installation_id": "i"});
        assert_eq!(
            status_of(
                challenge(&conn, unofficial.to_string().as_bytes(), "t")
                    .unwrap_or_else(|err| panic!("{err}"))
            ),
            403
        );
        assert!(challenge(&conn, b"{}", "t").is_err());
        for _ in 0..6 {
            let _ = challenge(&conn, request.to_string().as_bytes(), "trace");
        }
        assert_eq!(
            status_of(
                challenge(&conn, request.to_string().as_bytes(), "t")
                    .unwrap_or_else(|err| panic!("{err}"))
            ),
            429
        );
    }
}
