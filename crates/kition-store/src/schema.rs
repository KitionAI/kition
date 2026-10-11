//! The canonical schema, parsed from `schema/main.sql`.

pub const MAIN_SQL: &str = include_str!("../schema/main.sql");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub name: String,
    pub create_sql: String,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// The full definition after the name, for `ALTER TABLE ... ADD`.
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Index {
    pub name: String,
    pub create_sql: String,
}

pub struct Schema {
    pub tables: Vec<Table>,
    pub indexes: Vec<Index>,
}

pub fn parse(sql: &str) -> Schema {
    let mut tables = Vec::new();
    let mut indexes = Vec::new();
    let body: String = sql
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for statement in body.split(";\n").map(str::trim).filter(|s| !s.is_empty()) {
        let statement = statement.trim_end_matches(';');
        if let Some(rest) = statement.strip_prefix("CREATE TABLE ") {
            let name = quoted_name(rest);
            let columns = column_definitions(statement);
            tables.push(Table {
                name,
                create_sql: statement.to_owned(),
                columns,
            });
        } else if statement.starts_with("CREATE INDEX ")
            || statement.starts_with("CREATE UNIQUE INDEX ")
        {
            let after = statement.split_once("INDEX ").map_or("", |(_, rest)| rest);
            indexes.push(Index {
                name: quoted_name(after),
                create_sql: statement.replacen("INDEX ", "INDEX IF NOT EXISTS ", 1),
            });
        }
    }
    Schema { tables, indexes }
}

fn quoted_name(text: &str) -> String {
    let text = text.trim_start();
    match text.strip_prefix('`').and_then(|rest| rest.split_once('`')) {
        Some((name, _)) => name.to_owned(),
        None => text
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned(),
    }
}

/// Splits the parenthesized body on top-level commas and keeps column
/// definitions (entries that start with a quoted name).
fn column_definitions(statement: &str) -> Vec<Column> {
    let Some(open) = statement.find('(') else {
        return Vec::new();
    };
    let Some(close) = statement.rfind(')') else {
        return Vec::new();
    };
    let inner = &statement[open + 1..close];
    let mut parts = Vec::new();
    let mut depth = 0_i32;
    let mut start = 0;
    for (index, ch) in inner.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&inner[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&inner[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| part.starts_with('`'))
        .filter_map(|part| {
            let rest = part.strip_prefix('`')?;
            let (name, definition) = rest.split_once('`')?;
            Some(Column {
                name: name.to_owned(),
                definition: definition.trim().to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tables_columns_and_indexes() {
        let schema = parse(MAIN_SQL);
        assert_eq!(schema.tables.len(), 41);
        let users = schema.tables.iter().find(|table| table.name == "users");
        let users = users.unwrap_or_else(|| panic!("users table"));
        assert!(
            users
                .columns
                .iter()
                .any(|c| c.name == "created_at" && c.definition == "integer")
        );
        assert!(
            users
                .columns
                .iter()
                .any(|c| c.name == "role" && c.definition == "text DEFAULT \"user\"")
        );
        assert!(schema.indexes.iter().any(|index| {
            index.name == "idx_users_email"
                && index
                    .create_sql
                    .starts_with("CREATE UNIQUE INDEX IF NOT EXISTS")
        }));
        let records = schema
            .tables
            .iter()
            .find(|table| table.name == "kitable_records");
        assert_eq!(records.map(|t| t.columns.len()), Some(7));
    }

    #[test]
    fn no_text_timestamps_remain() {
        assert!(
            !MAIN_SQL
                .lines()
                .filter(|l| !l.starts_with("--"))
                .any(|l| l.contains(" datetime"))
        );
    }
}
