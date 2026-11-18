//! Row types for tables shared between features, generated with
//! [`row_type!`]. Each type serializes to the portable snapshot format used
//! in workspace state files (timestamps as milliseconds; legacy text
//! timestamps are accepted when reading).

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension};

/// A row type mapped to one table with an integer `id` primary key.
pub trait TableRow: Sized {
    const TABLE: &'static str;
    /// Column list, `id` first.
    const COLUMNS: &'static str;
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self>;
    /// Values in [`Self::COLUMNS`] order.
    fn values(&self) -> Vec<SqlValue>;
    fn id(&self) -> i64;
}

#[doc(hidden)]
pub mod convert {
    use rusqlite::types::Value as SqlValue;
    use serde_json::Value;

    pub fn int(v: i64) -> SqlValue {
        SqlValue::Integer(v)
    }
    pub fn opt(v: Option<i64>) -> SqlValue {
        v.map_or(SqlValue::Null, SqlValue::Integer)
    }
    pub fn text(v: &str) -> SqlValue {
        SqlValue::Text(v.to_owned())
    }
    pub fn json(v: &Value) -> SqlValue {
        if v.is_null() {
            SqlValue::Null
        } else {
            SqlValue::Text(v.to_string())
        }
    }
}

#[doc(hidden)]
pub mod de {
    use kition_core::Millis;
    use kition_core::time::parse_legacy;
    use serde_json::Value;

    pub fn int(value: Option<Value>) -> i64 {
        opt(value).unwrap_or_default()
    }
    pub fn opt(value: Option<Value>) -> Option<i64> {
        match value? {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }
    pub fn text(value: Option<Value>) -> String {
        match value {
            Some(Value::String(s)) => s,
            _ => String::new(),
        }
    }
    pub fn json(value: Option<Value>) -> Value {
        value.unwrap_or(Value::Null)
    }
    pub fn time(value: Option<Value>) -> Millis {
        opt_time(value).unwrap_or_default()
    }
    /// Milliseconds, or legacy text timestamps (the legacy zero time is unset).
    pub fn opt_time(value: Option<Value>) -> Option<Millis> {
        match value? {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => parse_legacy(&s).filter(|ms| *ms != -62_135_596_800_000),
            _ => None,
        }
    }
}

/// Declares a row struct. Field kinds: `int` (`i64`), `opt` (`Option<i64>`),
/// `text` (`String`), `json` (`serde_json::Value`), `time` (`Millis`),
/// `opt_time` (`Option<Millis>`).
#[macro_export]
macro_rules! row_type {
    (@ty int) => { i64 };
    (@ty opt) => { Option<i64> };
    (@ty text) => { String };
    (@ty json) => { serde_json::Value };
    (@ty time) => { kition_core::Millis };
    (@ty opt_time) => { Option<kition_core::Millis> };

    (@get $row:ident, $i:expr, int) => { $row.get::<_, Option<i64>>($i)?.unwrap_or_default() };
    (@get $row:ident, $i:expr, opt) => { $row.get::<_, Option<i64>>($i)? };
    (@get $row:ident, $i:expr, text) => { $row.get::<_, Option<String>>($i)?.unwrap_or_default() };
    (@get $row:ident, $i:expr, json) => { $crate::json_column($row.get::<_, Option<String>>($i)?) };
    (@get $row:ident, $i:expr, time) => { $row.get::<_, Option<i64>>($i)?.unwrap_or_default() };
    (@get $row:ident, $i:expr, opt_time) => { $row.get::<_, Option<i64>>($i)? };

    (@put $v:expr, int) => { $crate::rows::convert::int($v) };
    (@put $v:expr, opt) => { $crate::rows::convert::opt($v) };
    (@put $v:expr, text) => { $crate::rows::convert::text(&$v) };
    (@put $v:expr, json) => { $crate::rows::convert::json(&$v) };
    (@put $v:expr, time) => { $crate::rows::convert::int($v) };
    (@put $v:expr, opt_time) => { $crate::rows::convert::opt($v) };

    ($(#[$meta:meta])* $name:ident, $table:literal, { $($field:ident : $kind:ident),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
        pub struct $name {
            pub id: i64,
            $(pub $field: $crate::row_type!(@ty $kind),)*
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let mut map = <serde_json::Map<String, serde_json::Value> as serde::Deserialize>::deserialize(deserializer)?;
                Ok(Self {
                    id: $crate::rows::de::int(map.remove("id")),
                    $($field: $crate::rows::de::$kind(map.remove(stringify!($field))),)*
                })
            }
        }

        impl $crate::rows::TableRow for $name {
            const TABLE: &'static str = $table;
            const COLUMNS: &'static str = concat!("id", $(", ", stringify!($field)),*);

            #[allow(unused_assignments)]
            fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
                let mut index = 0_usize;
                let id: i64 = row.get(index)?;
                $(
                    index += 1;
                    let $field = $crate::row_type!(@get row, index, $kind);
                )*
                Ok(Self { id, $($field),* })
            }

            fn values(&self) -> Vec<rusqlite::types::Value> {
                vec![rusqlite::types::Value::Integer(self.id), $($crate::row_type!(@put self.$field.clone(), $kind)),*]
            }

            fn id(&self) -> i64 {
                self.id
            }
        }
    };

}

/// Rows matching `condition` (with `?1`.. parameters), ordered by `order`.
pub fn select<T: TableRow>(
    conn: &Connection,
    condition: &str,
    params: &[SqlValue],
    order: &str,
) -> rusqlite::Result<Vec<T>> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {condition} ORDER BY {order}",
        T::COLUMNS,
        T::TABLE
    );
    let mut statement = conn.prepare(&sql)?;
    statement
        .query_map(rusqlite::params_from_iter(params.iter()), T::from_row)?
        .collect()
}

pub fn find<T: TableRow>(conn: &Connection, id: i64) -> rusqlite::Result<Option<T>> {
    conn.query_row(
        &format!("SELECT {} FROM {} WHERE id = ?1", T::COLUMNS, T::TABLE),
        [id],
        T::from_row,
    )
    .optional()
}

/// Inserts the row with its own ID; returns the new ID.
pub fn insert<T: TableRow>(conn: &Connection, row: &T) -> rusqlite::Result<i64> {
    let mut values = row.values();
    let columns: Vec<&str> = T::COLUMNS.split(", ").collect();
    let (columns, values): (Vec<&str>, Vec<SqlValue>) = if row.id() == 0 {
        values.remove(0);
        (columns[1..].to_vec(), values)
    } else {
        (columns, values)
    };
    let placeholders = (1..=values.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO {} ({}) VALUES ({placeholders})",
            T::TABLE,
            columns.join(", ")
        ),
        rusqlite::params_from_iter(values.iter()),
    )?;
    Ok(conn.last_insert_rowid())
}

/// Writes every column of an existing row.
pub fn update<T: TableRow>(conn: &Connection, row: &T) -> rusqlite::Result<usize> {
    let columns: Vec<&str> = T::COLUMNS.split(", ").skip(1).collect();
    let assignments = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{c} = ?{}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("UPDATE {} SET {assignments} WHERE id = ?1", T::TABLE),
        rusqlite::params_from_iter(row.values().iter()),
    )
}

/// Inserts the row unless one with the same ID exists (imports keep IDs).
pub fn insert_if_absent<T: TableRow>(conn: &Connection, row: &T) -> rusqlite::Result<()> {
    if row.id() != 0 && find::<T>(conn, row.id())?.is_some() {
        return Ok(());
    }
    insert(conn, row).map(|_| ())
}

crate::row_type!(
    /// An agent conversation's index entry; the conversation itself is the
    /// session event log (`agent_session_events`).
    AgentSession, "agent_sessions", {
        user_id: int, title: text, workspace_root: text, active_document_path: text,
        model_id: text, extra_data: json, created_at: time, updated_at: time,
    }
);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Db;

    #[test]
    fn round_trips_rows_and_snapshots() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let session = AgentSession {
            user_id: 2,
            title: "T".into(),
            extra_data: json!({"a": 1}),
            created_at: 5,
            ..Default::default()
        };
        let id = insert(&conn, &session).unwrap_or_else(|err| panic!("{err}"));
        let mut loaded = find::<AgentSession>(&conn, id)
            .ok()
            .flatten()
            .unwrap_or_default();
        assert_eq!(loaded.title, "T");
        assert_eq!(loaded.extra_data, json!({"a": 1}));
        loaded.title = "U".into();
        update(&conn, &loaded).unwrap_or_else(|err| panic!("{err}"));
        let listed: Vec<AgentSession> =
            select(&conn, "user_id = ?1", &[SqlValue::Integer(2)], "id ASC").unwrap_or_default();
        assert_eq!(listed[0].title, "U");

        let legacy = json!({"id": 9, "user_id": 2, "title": "Old",
            "created_at": "2026-10-09T03:57:06Z", "updated_at": "0001-01-01T00:00:00Z"});
        let old: AgentSession =
            serde_json::from_value(legacy).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!((old.created_at, old.updated_at), (1_791_518_226_000, 0));
        insert_if_absent(&conn, &old).unwrap_or_else(|err| panic!("{err}"));
        insert_if_absent(&conn, &old).unwrap_or_else(|err| panic!("{err}"));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_sessions WHERE id = 9",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        assert_eq!(count, 1);
        assert_eq!(
            serde_json::to_value(&old)
                .ok()
                .and_then(|v| v.get("created_at").cloned()),
            Some(json!(1_791_518_226_000_i64))
        );
    }
}
