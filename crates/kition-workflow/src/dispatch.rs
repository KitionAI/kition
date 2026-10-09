//! Time-driven triggers: `record_date_reached` (a record's date column
//! reaches today at a clock time, in UTC) and `scheduled_time` (cron), plus
//! the daily run-history cleanup.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use serde_json::Value;

use crate::cron;
use crate::engine::{DeliveryEvent, Engine};
use crate::store::{Dedup, dedup_key};
use crate::types::missing_required_field;

const DEFAULT_USER_ID: i64 = 1;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// A date cell as a UTC instant: RFC 3339 / `YYYY-MM-DDTHH:MM:SS` /
/// `YYYY-MM-DD` text, or Unix seconds.
pub fn parse_date_value(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            if let Ok(time) = DateTime::parse_from_rfc3339(text) {
                return Some(time.with_timezone(&Utc));
            }
            if let Ok(naive) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S") {
                return Some(naive.and_utc());
            }
            NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|n| n.and_utc())
        }
        Value::Number(number) => {
            let seconds = number
                .as_i64()
                .or_else(|| number.as_f64().map(|f| f as i64))?;
            Utc.timestamp_opt(seconds, 0).single()
        }
        _ => None,
    }
}

/// `%d:%d` parsing of an `atTime` value.
fn parse_at_time(text: &str) -> Option<(i64, i64)> {
    let (hours, minutes) = text.split_once(':')?;
    let digits = |s: &str| {
        s.strip_prefix(['+', '-'])
            .unwrap_or(s)
            .chars()
            .take_while(char::is_ascii_digit)
            .count()
    };
    let hours_text = &hours[..hours.len()];
    if digits(hours_text) == 0 || digits(minutes) == 0 {
        return None;
    }
    let sign_len = |s: &str| usize::from(s.starts_with(['+', '-']));
    let h: i64 = hours_text.parse().ok()?;
    let m_text = &minutes[..sign_len(minutes) + digits(minutes)];
    Some((h, m_text.parse().ok()?))
}

pub struct TimeDispatcher {
    pub engine: Arc<Engine>,
    pub dedup: Arc<Dedup>,
    last_gc_day: std::sync::Mutex<String>,
}

impl TimeDispatcher {
    pub fn new(engine: Arc<Engine>, dedup: Arc<Dedup>) -> Self {
        Self {
            engine,
            dedup,
            last_gc_day: std::sync::Mutex::default(),
        }
    }

    fn maybe_gc(&self, today: &str) {
        let mut last = self
            .last_gc_day
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *last == today {
            return;
        }
        *last = today.to_owned();
        if let Err(err) = self.dedup.gc_before(today) {
            tracing::warn!(cutoff = today, error = %err, "workflow dedup GC failed");
        }
    }

    /// One scan of enabled `record_date_reached` workflows at `now`.
    pub async fn tick(&self, now: DateTime<Utc>) {
        let today = now.format("%Y-%m-%d").to_string();
        self.maybe_gc(&today);
        for def in self.engine.store.list_enabled() {
            if def.trigger.trigger_type != "record_date_reached" {
                continue;
            }
            let Some(date_field) = def
                .trigger
                .date_field
                .as_ref()
                .filter(|d| !d.field_id.trim().is_empty())
            else {
                continue;
            };
            let table_id = def.trigger.table_id.trim().to_owned();
            if table_id.is_empty() {
                continue;
            }
            let (hours, minutes) = match date_field.at_time.trim() {
                "" => (0, 0),
                at => match parse_at_time(at) {
                    Some(parsed) => parsed,
                    None => {
                        tracing::warn!(workflow_id = %def.id, at_time = at, "workflow time dispatcher: invalid atTime");
                        continue;
                    }
                },
            };
            let midnight = now
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|n| n.and_utc())
                .unwrap_or(now);
            let fire_at =
                midnight + chrono::Duration::hours(hours) + chrono::Duration::minutes(minutes);
            if now < fire_at {
                continue;
            }
            let (document_id, table) = (def.trigger.document_id.clone(), table_id.clone());
            let records = match self.engine.tables.clone() {
                None => continue,
                Some(tables) => {
                    tokio::task::spawn_blocking(move || {
                        tables.records(DEFAULT_USER_ID, &document_id, &table)
                    })
                    .await
                }
            };
            let records = match records {
                Ok(Ok(records)) => records,
                Ok(Err(err)) => {
                    tracing::warn!(workflow_id = %def.id, table_id, error = %err, "workflow time dispatcher: failed to read records");
                    continue;
                }
                Err(_) => continue,
            };
            for record in records {
                let Some(date) = record
                    .fields
                    .get(&date_field.field_id)
                    .and_then(parse_date_value)
                else {
                    continue;
                };
                if date.format("%Y-%m-%d").to_string() != today {
                    continue;
                }
                if !missing_required_field(&def.trigger.required_fields, &record.fields).is_empty()
                {
                    continue;
                }
                let key = dedup_key(&def.id, &record.id, &today);
                if self.dedup.seen(&key) {
                    continue;
                }
                if let Err(err) = self.dedup.mark(&key) {
                    tracing::warn!(workflow_id = %def.id, key, error = %err, "workflow time dispatcher: dedup persist failed");
                }
                let event = DeliveryEvent {
                    user_id: DEFAULT_USER_ID,
                    document_id: def.trigger.document_id.clone(),
                    table_id: table_id.clone(),
                    record_id: record.id.clone(),
                    fields: record.fields.clone(),
                };
                let mut run = self.engine.deliver(&def, &event).await;
                run.trigger_event = "record_date_reached".into();
                if let Err(err) = self.engine.runs.append(run) {
                    tracing::error!(workflow_id = %def.id, error = %err, "workflow time dispatcher: run history append failed");
                }
            }
        }
    }
}

pub struct ScheduledDispatcher {
    pub engine: Arc<Engine>,
    pub dedup: Arc<Dedup>,
    last_gc_day: std::sync::Mutex<String>,
}

pub fn scheduled_dedup_key(workflow_id: &str, fire_minute: i64, day: &str) -> String {
    format!("scheduled::{workflow_id}::{fire_minute}::{day}")
}

impl ScheduledDispatcher {
    pub fn new(engine: Arc<Engine>, dedup: Arc<Dedup>) -> Self {
        Self {
            engine,
            dedup,
            last_gc_day: std::sync::Mutex::default(),
        }
    }

    /// Fires every `scheduled_time` workflow due in the minute containing
    /// `now` (process local time).
    pub async fn tick(&self, now: DateTime<Local>) {
        let current = now
            .with_second(0)
            .and_then(|t| t.with_nanosecond(0))
            .unwrap_or(now);
        let previous = current - chrono::Duration::minutes(1);
        let next = current + chrono::Duration::minutes(1);
        let day = current.format("%Y-%m-%d").to_string();
        {
            let mut last = self
                .last_gc_day
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *last != day {
                *last = day.clone();
                if let Err(err) = self.dedup.gc_before(&day) {
                    tracing::warn!(cutoff = day, error = %err, "workflow dedup GC failed");
                }
            }
        }
        for def in self.engine.store.list_enabled() {
            if def.trigger.trigger_type != "scheduled_time" {
                continue;
            }
            let Some(schedule) = &def.trigger.schedule else {
                continue;
            };
            let spec = schedule.cron.trim();
            if spec.is_empty() {
                continue;
            }
            let tz = schedule.timezone.trim();
            let key = if tz.is_empty() {
                spec.to_owned()
            } else {
                format!("CRON_TZ={tz} {spec}")
            };
            let parsed = match cron::parse(&key) {
                Ok(parsed) => parsed,
                Err(err) => {
                    tracing::warn!(workflow_id = %def.id, cron = spec, tz, error = %err, "workflow scheduled dispatcher: cron parse failed");
                    continue;
                }
            };
            let Some(fire) = parsed.next(previous.with_timezone(&Utc)) else {
                continue;
            };
            if fire < current.with_timezone(&Utc) || fire >= next.with_timezone(&Utc) {
                continue;
            }
            let fire_minute = fire.timestamp() - fire.timestamp().rem_euclid(60);
            let dedup = scheduled_dedup_key(&def.id, fire_minute, &day);
            if self.dedup.seen(&dedup) {
                continue;
            }
            if let Err(err) = self.dedup.mark(&dedup) {
                tracing::warn!(workflow_id = %def.id, key = dedup, error = %err, "workflow scheduled dispatcher: dedup persist failed");
            }
            let run = self
                .engine
                .execute(
                    &def,
                    "scheduled_time",
                    DEFAULT_USER_ID,
                    "",
                    &def.trigger.document_id,
                    &def.trigger.table_id,
                    None,
                )
                .await;
            if let Err(err) = self.engine.runs.append(run) {
                tracing::error!(workflow_id = %def.id, error = %err, "workflow scheduled dispatcher: run history append failed");
            }
        }
    }
}

/// Starts both dispatchers (every minute, first scan immediately) and the
/// daily run-history cleanup.
pub fn start(engine: Arc<Engine>, dedup: Arc<Dedup>) {
    let time = TimeDispatcher::new(Arc::clone(&engine), Arc::clone(&dedup));
    let scheduled = ScheduledDispatcher::new(Arc::clone(&engine), dedup);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            ticker.tick().await;
            time.tick(Utc::now()).await;
            scheduled.tick(Local::now()).await;
        }
    });
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let now = kition_core::now_millis();
            match engine.runs.gc(now - 14 * DAY_MS, now - 30 * DAY_MS) {
                Ok((ok, error)) if ok > 0 || error > 0 => {
                    tracing::info!(ok, error, "workflow run history GC")
                }
                Ok(_) => {}
                Err(err) => tracing::warn!(error = %err, "workflow run history GC failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_date_cells_and_times() {
        assert_eq!(
            parse_date_value(&json!("2026-06-01")).map(|t| t.to_rfc3339()),
            Some("2026-06-01T00:00:00+00:00".into())
        );
        assert_eq!(
            parse_date_value(&json!("2026-06-01T23:30:00-02:00"))
                .map(|t| t.format("%Y-%m-%d").to_string()),
            Some("2026-06-02".into())
        );
        assert_eq!(parse_date_value(&json!(0)).map(|t| t.timestamp()), Some(0));
        assert_eq!(
            parse_date_value(&json!(1.9)).map(|t| t.timestamp()),
            Some(1)
        );
        assert!(parse_date_value(&json!("soon")).is_none());
        assert_eq!(parse_at_time("09:30"), Some((9, 30)));
        assert_eq!(parse_at_time("9:5"), Some((9, 5)));
        assert_eq!(parse_at_time("x"), None);
    }
}
