//! Five-field cron schedules (minute hour day-of-month month day-of-week)
//! with the legacy scheduler's parsing rules, error texts, and next-fire
//! algorithm, including `CRON_TZ=` / `TZ=` prefixes.

use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc,
};

const STAR_BIT: u64 = 1 << 63;

struct Bounds {
    min: u32,
    max: u32,
    names: &'static [(&'static str, u32)],
}

const MINUTES: Bounds = Bounds {
    min: 0,
    max: 59,
    names: &[],
};
const HOURS: Bounds = Bounds {
    min: 0,
    max: 23,
    names: &[],
};
const DOM: Bounds = Bounds {
    min: 1,
    max: 31,
    names: &[],
};
const MONTHS: Bounds = Bounds {
    min: 1,
    max: 12,
    names: &[
        ("jan", 1),
        ("feb", 2),
        ("mar", 3),
        ("apr", 4),
        ("may", 5),
        ("jun", 6),
        ("jul", 7),
        ("aug", 8),
        ("sep", 9),
        ("oct", 10),
        ("nov", 11),
        ("dec", 12),
    ],
};
const DOW: Bounds = Bounds {
    min: 0,
    max: 6,
    names: &[
        ("sun", 0),
        ("mon", 1),
        ("tue", 2),
        ("wed", 3),
        ("thu", 4),
        ("fri", 5),
        ("sat", 6),
    ],
};

/// A time zone: the process zone or an IANA zone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Zone {
    Local,
    Named(chrono_tz::Tz),
}

/// Resolves a zone name like the legacy loader: empty or `UTC` is UTC,
/// `Local` is the process zone.
pub fn load_location(name: &str) -> Result<Zone, String> {
    match name {
        "" | "UTC" => Ok(Zone::Named(chrono_tz::UTC)),
        "Local" => Ok(Zone::Local),
        other => other
            .parse::<chrono_tz::Tz>()
            .map(Zone::Named)
            .map_err(|_| format!("unknown time zone {other}")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    minute: u64,
    hour: u64,
    dom: u64,
    month: u64,
    dow: u64,
    pub zone: Zone,
}

fn go_atoi(text: &str) -> Result<i64, String> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "strconv.Atoi: parsing {}: invalid syntax",
            crate::gofmt::quote(text)
        ));
    }
    text.parse::<i64>().map_err(|_| {
        format!(
            "strconv.Atoi: parsing {}: value out of range",
            crate::gofmt::quote(text)
        )
    })
}

fn must_parse_int(expr: &str) -> Result<u32, String> {
    let num = go_atoi(expr).map_err(|err| format!("failed to parse int from {expr}: {err}"))?;
    if num < 0 {
        return Err(format!("negative number ({num}) not allowed: {expr}"));
    }
    Ok(u32::try_from(num).unwrap_or(u32::MAX))
}

fn parse_int_or_name(expr: &str, bounds: &Bounds) -> Result<u32, String> {
    let lower = expr.to_lowercase();
    if let Some((_, value)) = bounds.names.iter().find(|(name, _)| *name == lower) {
        return Ok(*value);
    }
    must_parse_int(expr)
}

fn get_range(expr: &str, bounds: &Bounds) -> Result<u64, String> {
    let range_and_step: Vec<&str> = expr.split('/').collect();
    let low_and_high: Vec<&str> = range_and_step[0].split('-').collect();
    let single = low_and_high.len() == 1;
    let mut extra = 0;
    let (start, mut end) = if low_and_high[0] == "*" || low_and_high[0] == "?" {
        extra = STAR_BIT;
        (bounds.min, bounds.max)
    } else {
        let start = parse_int_or_name(low_and_high[0], bounds)?;
        let end = match low_and_high.len() {
            1 => start,
            2 => parse_int_or_name(low_and_high[1], bounds)?,
            _ => return Err(format!("too many hyphens: {expr}")),
        };
        (start, end)
    };
    let step = match range_and_step.len() {
        1 => 1,
        2 => {
            let step = must_parse_int(range_and_step[1])?;
            if single {
                end = bounds.max;
            }
            if step > 1 {
                extra = 0;
            }
            step
        }
        _ => return Err(format!("too many slashes: {expr}")),
    };
    if start < bounds.min {
        return Err(format!(
            "beginning of range ({start}) below minimum ({}): {expr}",
            bounds.min
        ));
    }
    if end > bounds.max {
        return Err(format!(
            "end of range ({end}) above maximum ({}): {expr}",
            bounds.max
        ));
    }
    if start > end {
        return Err(format!(
            "beginning of range ({start}) beyond end of range ({end}): {expr}"
        ));
    }
    if step == 0 {
        return Err(format!("step of range should be a positive number: {expr}"));
    }
    let mut bits = 0u64;
    let mut value = start;
    while value <= end {
        bits |= 1 << value;
        value += step;
    }
    Ok(bits | extra)
}

fn get_field(field: &str, bounds: &Bounds) -> Result<u64, String> {
    let mut bits = 0;
    for expr in field.split(',').filter(|part| !part.is_empty()) {
        bits |= get_range(expr, bounds)?;
    }
    Ok(bits)
}

/// Parses a schedule; zone-less specs use the process zone.
pub fn parse(spec: &str) -> Result<Schedule, String> {
    if spec.is_empty() {
        return Err("empty spec string".into());
    }
    let mut zone = Zone::Local;
    let mut spec = spec;
    if spec.starts_with("TZ=") || spec.starts_with("CRON_TZ=") {
        let space = spec.find(' ').unwrap_or(spec.len());
        let eq = spec.find('=').unwrap_or(0);
        let name = spec.get(eq + 1..space).unwrap_or_default();
        zone = load_location(name).map_err(|err| format!("provided bad location {name}: {err}"))?;
        spec = spec[space..].trim();
    }
    if spec.starts_with('@') {
        return Err(format!("parser does not accept descriptors: {spec}"));
    }
    let fields: Vec<&str> = spec.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "expected exactly 5 fields, found {}: [{}]",
            fields.len(),
            fields.join(" ")
        ));
    }
    Ok(Schedule {
        minute: get_field(fields[0], &MINUTES)?,
        hour: get_field(fields[1], &HOURS)?,
        dom: get_field(fields[2], &DOM)?,
        month: get_field(fields[3], &MONTHS)?,
        dow: get_field(fields[4], &DOW)?,
        zone,
    })
}

/// A local wall-clock time, resolved like the legacy clock: gaps move
/// forward, ambiguous times take the earlier instant.
fn resolve<Tz: TimeZone>(zone: &Tz, naive: NaiveDateTime) -> DateTime<Tz> {
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
        LocalResult::None => {
            let mut probe = naive;
            for _ in 0..8 {
                probe += Duration::minutes(30);
                if let LocalResult::Single(t) | LocalResult::Ambiguous(t, _) =
                    zone.from_local_datetime(&probe)
                {
                    return t - (probe - naive);
                }
            }
            zone.from_utc_datetime(&naive)
        }
    }
}

fn add_months(date: NaiveDate, months: u32) -> NaiveDate {
    let total = date.year() * 12 + date.month0() as i32 + months as i32;
    NaiveDate::from_ymd_opt(total.div_euclid(12), total.rem_euclid(12) as u32 + 1, 1)
        .unwrap_or(date)
}

impl Schedule {
    fn day_matches<Tz: TimeZone>(&self, t: &DateTime<Tz>) -> bool {
        let dom = 1 << t.day() & self.dom > 0;
        let dow = 1 << t.weekday().num_days_from_sunday() & self.dow > 0;
        if self.dom & STAR_BIT > 0 || self.dow & STAR_BIT > 0 {
            dom && dow
        } else {
            dom || dow
        }
    }

    /// The first fire time strictly after `after`, or `None` within five
    /// years.
    pub fn next(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self.zone {
            Zone::Local => self
                .next_in(&chrono::Local, after.with_timezone(&chrono::Local))
                .map(|t| t.with_timezone(&Utc)),
            Zone::Named(tz) => self
                .next_in(&tz, after.with_timezone(&tz))
                .map(|t| t.with_timezone(&Utc)),
        }
    }

    fn next_in<Tz: TimeZone>(&self, zone: &Tz, start: DateTime<Tz>) -> Option<DateTime<Tz>> {
        // The upcoming whole second.
        let mut t = start.clone() + Duration::seconds(1)
            - Duration::nanoseconds(i64::from(start.nanosecond()));
        let mut added = false;
        let year_limit = t.year() + 5;
        'wrap: loop {
            if t.year() > year_limit {
                return None;
            }
            while 1 << t.month() & self.month == 0 {
                if !added {
                    added = true;
                    t = resolve(
                        zone,
                        NaiveDate::from_ymd_opt(t.year(), t.month(), 1)?.and_hms_opt(0, 0, 0)?,
                    );
                }
                let next = add_months(t.date_naive(), 1);
                t = resolve(zone, next.and_hms_opt(t.hour(), t.minute(), t.second())?);
                if t.month() == 1 {
                    continue 'wrap;
                }
            }
            while !self.day_matches(&t) {
                if !added {
                    added = true;
                    t = resolve(zone, t.date_naive().and_hms_opt(0, 0, 0)?);
                }
                let next = t.date_naive().succ_opt()?;
                t = resolve(zone, next.and_hms_opt(t.hour(), t.minute(), t.second())?);
                if t.hour() != 0 {
                    if t.hour() > 12 {
                        t += Duration::hours(i64::from(24 - t.hour()));
                    } else {
                        t -= Duration::hours(i64::from(t.hour()));
                    }
                }
                if t.day() == 1 {
                    continue 'wrap;
                }
            }
            while 1 << t.hour() & self.hour == 0 {
                if !added {
                    added = true;
                    t = resolve(zone, t.date_naive().and_hms_opt(t.hour(), 0, 0)?);
                }
                t += Duration::hours(1);
                if t.hour() == 0 {
                    continue 'wrap;
                }
            }
            while 1 << t.minute() & self.minute == 0 {
                if !added {
                    added = true;
                    t -= Duration::seconds(i64::from(t.second()));
                }
                t += Duration::minutes(1);
                if t.minute() == 0 {
                    continue 'wrap;
                }
            }
            // Seconds always fire at :00.
            while t.second() != 0 {
                if !added {
                    added = true;
                }
                t += Duration::seconds(1);
                if t.second() == 0 {
                    continue 'wrap;
                }
            }
            return Some(t);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_default()
    }

    fn next(spec: &str, after: &str) -> Option<String> {
        parse(spec)
            .ok()?
            .next(utc(after))
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    }

    #[test]
    fn computes_next_fire_times() {
        assert_eq!(
            next("CRON_TZ=UTC 0 9 * * *", "2026-06-17T08:59:30Z").as_deref(),
            Some("2026-06-17T09:00:00Z")
        );
        assert_eq!(
            next("CRON_TZ=UTC 0 9 * * *", "2026-06-17T09:00:00Z").as_deref(),
            Some("2026-06-18T09:00:00Z")
        );
        assert_eq!(
            next("CRON_TZ=Asia/Shanghai 0 9 * * *", "2026-06-17T00:00:00Z").as_deref(),
            Some("2026-06-17T01:00:00Z")
        );
        assert_eq!(
            next("TZ=UTC */15 * * * *", "2026-06-17T10:07:00Z").as_deref(),
            Some("2026-06-17T10:15:00Z")
        );
        assert_eq!(
            next("CRON_TZ=UTC 0 9 * * mon-fri", "2026-06-19T10:00:00Z").as_deref(),
            Some("2026-06-22T09:00:00Z")
        );
        assert_eq!(
            next("CRON_TZ=UTC 0 0 1 jan *", "2026-06-19T10:00:00Z").as_deref(),
            Some("2027-01-01T00:00:00Z")
        );
        assert_eq!(
            next("CRON_TZ=UTC 0 0 13 * fri", "2026-06-01T00:00:00Z").as_deref(),
            Some("2026-06-05T00:00:00Z")
        );
        assert_eq!(next("CRON_TZ=UTC 0 9 30 2 *", "2026-01-01T00:00:00Z"), None);
        // New York spring-forward gap: 02:30 does not exist on 2026-03-08,
        // so (like the legacy scheduler) that day is skipped.
        assert_eq!(
            next(
                "CRON_TZ=America/New_York 30 2 * * *",
                "2026-03-07T12:00:00Z"
            )
            .as_deref(),
            Some("2026-03-09T06:30:00Z")
        );
        // Fall-back day: 01:30 happens twice; the first one fires.
        assert_eq!(
            next(
                "CRON_TZ=America/New_York 30 1 * * *",
                "2026-11-01T04:00:00Z"
            )
            .as_deref(),
            Some("2026-11-01T05:30:00Z")
        );
    }

    #[test]
    fn reports_parse_errors_like_the_legacy_scheduler() {
        let err = |spec: &str| parse(spec).err().unwrap_or_default();
        assert_eq!(err(""), "empty spec string");
        assert_eq!(err("bad"), "expected exactly 5 fields, found 1: [bad]");
        assert_eq!(err("@daily"), "parser does not accept descriptors: @daily");
        assert_eq!(
            err("61 * * * *"),
            "end of range (61) above maximum (59): 61"
        );
        assert_eq!(
            err("x * * * *"),
            "failed to parse int from x: strconv.Atoi: parsing \"x\": invalid syntax"
        );
        assert_eq!(
            err("* * 0 * *"),
            "beginning of range (0) below minimum (1): 0"
        );
        assert_eq!(
            err("5-1 * * * *"),
            "beginning of range (5) beyond end of range (1): 5-1"
        );
        assert_eq!(
            err("*/0 * * * *"),
            "step of range should be a positive number: */0"
        );
        assert_eq!(err("1-2-3 * * * *"), "too many hyphens: 1-2-3");
        assert_eq!(err("1/2/3 * * * *"), "too many slashes: 1/2/3");
        assert_eq!(err("* * * * 7"), "end of range (7) above maximum (6): 7");
        assert_eq!(
            err("CRON_TZ=Mars/Base 0 9 * * *"),
            "provided bad location Mars/Base: unknown time zone Mars/Base"
        );
        assert!(parse("0 9 * * MON,wed").is_ok());
    }
}
