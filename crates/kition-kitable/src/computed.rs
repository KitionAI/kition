//! Derived values: `link_to_record` chips, lookups, rollups, and formulas.

use std::collections::HashMap;

use rusqlite::params;
use serde_json::{Map, Value, json};

use crate::json::{self, number, to_bool, to_number, to_text};
use crate::source::{Field, Table};
use crate::{KitableFile, Result};

impl KitableFile {
    /// Recomputes derived fields for one record. Returns the new values and
    /// whether anything changed.
    pub(crate) fn recompute_derived_fields(
        &self,
        table: &Table,
        record_id: i64,
        values: &Map<String, Value>,
    ) -> Result<(Map<String, Value>, bool)> {
        let mut next = values.clone();
        let mut changed = false;
        for field in &table.fields {
            let computed = match field.field_type.as_str() {
                "lookup" => self.compute_lookup(record_id, field),
                "rollup" => self.compute_rollup(record_id, field),
                "link_to_record" => self.compute_link_refs(record_id, field),
                "formula" => match compute_formula(&field.formula, &next) {
                    Ok(value) => Ok(value),
                    Err(message) => Ok(Value::String(format!("#ERROR: {message}"))),
                },
                _ => continue,
            }?;
            // A missing value counts as null, as in the legacy comparison.
            let current = next.get(&field.name).unwrap_or(&Value::Null);
            if !json::equal(current, &computed) {
                next.insert(field.name.clone(), computed);
                changed = true;
            }
        }
        Ok((next, changed))
    }

    pub(crate) fn apply_recomputed_values(
        &self,
        table: &Table,
        record_id: i64,
        values: &Map<String, Value>,
    ) -> Result<()> {
        let (next, changed) = self.recompute_derived_fields(table, record_id, values)?;
        if changed {
            self.conn.execute(
                "UPDATE kition_records SET values_json = ?1 WHERE id = ?2",
                params![serde_json::to_string(&next)?, record_id],
            )?;
        }
        Ok(())
    }

    /// Refreshes derived values on the source record after its links change.
    /// Failures are ignored; the link change itself already succeeded.
    pub(crate) fn recompute_after_link_change(&self, table_id: i64, record_id: i64) {
        let Ok(table) = self.get_table(table_id) else {
            return;
        };
        let Ok(record) = self.get_record(table_id, record_id) else {
            return;
        };
        let _ = self.apply_recomputed_values(&table, record_id, &record.values);
    }

    fn compute_link_refs(&self, record_id: i64, field: &Field) -> Result<Value> {
        let refs = self.list_record_links(field.table_id, record_id, field.id)?;
        Ok(Value::Array(
            refs.into_iter()
                .map(|r| json!({ "row_key": r.row_key, "display": r.display }))
                .collect(),
        ))
    }

    fn linked_values(
        &self,
        record_id: i64,
        link_field_id: i64,
        ordered: bool,
    ) -> Result<Vec<Map<String, Value>>> {
        let order = if ordered { " ORDER BY l.id ASC" } else { "" };
        let mut statement = self.conn.prepare(&format!(
            "SELECT r.values_json FROM kition_record_links l JOIN kition_records r ON r.id = l.to_record_id \
             WHERE l.from_record_id = ?1 AND l.from_field_id = ?2 AND r.deleted_at IS NULL{order}"
        ))?;
        let rows = statement
            .query_map(params![record_id, link_field_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows.iter().map(|raw| json::object(raw)).collect())
    }

    fn compute_lookup(&self, record_id: i64, field: &Field) -> Result<Value> {
        let link_field_id = json::int_option(&field.options, "link_field_id");
        let target_field_id = json::int_option(&field.options, "target_field_id");
        if link_field_id == 0 || target_field_id == 0 {
            return Ok(Value::Null);
        }
        let Ok(target) = self.get_field_by_id(target_field_id) else {
            return Ok(Value::Null);
        };
        let collected: Vec<Value> = self
            .linked_values(record_id, link_field_id, true)?
            .into_iter()
            .filter_map(|mut values| values.remove(&target.name).filter(|v| !v.is_null()))
            .collect();
        if field
            .options
            .get("multi_value_mode")
            .and_then(Value::as_str)
            == Some("concat")
        {
            return Ok(Value::String(
                collected.iter().map(to_text).collect::<Vec<_>>().join(", "),
            ));
        }
        Ok(Value::Array(collected))
    }

    fn compute_rollup(&self, record_id: i64, field: &Field) -> Result<Value> {
        let link_field_id = json::int_option(&field.options, "link_field_id");
        let target_field_id = json::int_option(&field.options, "target_field_id");
        let aggregation = field
            .options
            .get("aggregation")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if link_field_id == 0 || aggregation.is_empty() {
            return Ok(Value::Null);
        }
        let target_name = self
            .get_field_by_id(target_field_id)
            .map(|f| f.name)
            .unwrap_or_default();
        let values: Vec<Value> = self
            .linked_values(record_id, link_field_id, false)?
            .into_iter()
            .filter_map(|mut values| {
                if target_name.is_empty() {
                    Some(Value::Object(values))
                } else {
                    values.remove(&target_name).filter(|v| !v.is_null())
                }
            })
            .collect();
        Ok(aggregate(aggregation, &values))
    }
}

fn aggregate(aggregation: &str, values: &[Value]) -> Value {
    let numbers = || values.iter().map(to_number);
    match aggregation {
        "count" => number(values.len() as f64),
        "sum" => number(numbers().sum()),
        "avg" => {
            if values.is_empty() {
                number(0.0)
            } else {
                number(numbers().sum::<f64>() / values.len() as f64)
            }
        }
        "max" => number(numbers().reduce(f64::max).unwrap_or(0.0)),
        "min" => number(numbers().reduce(f64::min).unwrap_or(0.0)),
        "and" => Value::Bool(!values.is_empty() && values.iter().all(to_bool)),
        "or" => Value::Bool(values.iter().any(to_bool)),
        "concat" => Value::String(values.iter().map(to_text).collect::<Vec<_>>().join(", ")),
        _ => Value::Null,
    }
}

/// Evaluates a formula over the record's values. `{name}` references a
/// field; supports `+ - * /`, parentheses, unary minus, string and number
/// literals, `true`/`false`/`null`, and `if`, `concat`, `upper`, `lower`,
/// `len`. `+` concatenates when either side is a string.
pub fn compute_formula(
    expression: &str,
    values: &Map<String, Value>,
) -> std::result::Result<Value, String> {
    let expression = expression.trim();
    if expression.is_empty() {
        return Ok(Value::Null);
    }
    let lookup: HashMap<&str, &Value> = values.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let mut parser = Parser {
        src: expression.as_bytes(),
        pos: 0,
        values: &lookup,
    };
    let result = parser.expression()?;
    parser.skip_spaces();
    if parser.pos < parser.src.len() {
        return Err(format!("unexpected token at {}", parser.pos));
    }
    Ok(result)
}

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
    values: &'a HashMap<&'a str, &'a Value>,
}

impl Parser<'_> {
    fn skip_spaces(&mut self) {
        while self.pos < self.src.len() && is_space(self.src[self.pos]) {
            self.pos += 1;
        }
    }

    fn peek(&self) -> u8 {
        self.src.get(self.pos).copied().unwrap_or(0)
    }

    fn text(&self, start: usize, end: usize) -> String {
        String::from_utf8_lossy(&self.src[start..end]).into_owned()
    }

    fn expression(&mut self) -> std::result::Result<Value, String> {
        let mut left = self.term()?;
        loop {
            self.skip_spaces();
            let op = self.peek();
            if op != b'+' && op != b'-' {
                return Ok(left);
            }
            self.pos += 1;
            let right = self.term()?;
            left = if op == b'+' && (left.is_string() || right.is_string()) {
                Value::String(to_text(&left) + &to_text(&right))
            } else if op == b'+' {
                number(to_number(&left) + to_number(&right))
            } else {
                number(to_number(&left) - to_number(&right))
            };
        }
    }

    fn term(&mut self) -> std::result::Result<Value, String> {
        let mut left = self.factor()?;
        loop {
            self.skip_spaces();
            let op = self.peek();
            if op != b'*' && op != b'/' {
                return Ok(left);
            }
            self.pos += 1;
            let right = self.factor()?;
            if op == b'*' {
                left = number(to_number(&left) * to_number(&right));
            } else {
                let divisor = to_number(&right);
                if divisor == 0.0 {
                    return Err("division by zero".to_owned());
                }
                left = number(to_number(&left) / divisor);
            }
        }
    }

    fn factor(&mut self) -> std::result::Result<Value, String> {
        self.skip_spaces();
        if self.pos >= self.src.len() {
            return Err("unexpected end of expression".to_owned());
        }
        match self.peek() {
            b'(' => {
                self.pos += 1;
                let value = self.expression()?;
                self.skip_spaces();
                if self.peek() != b')' {
                    return Err("expected ')'".to_owned());
                }
                self.pos += 1;
                Ok(value)
            }
            b'-' => {
                self.pos += 1;
                let value = self.factor()?;
                Ok(number(-to_number(&value)))
            }
            b'{' => self.field_reference(),
            quote @ (b'\'' | b'"') => self.string(quote),
            b'0'..=b'9' => self.number(),
            ch if is_ident_start(ch) => self.identifier_or_call(),
            ch => Err(format!(
                "unexpected character '{}' at {}",
                char::from(ch),
                self.pos
            )),
        }
    }

    fn field_reference(&mut self) -> std::result::Result<Value, String> {
        self.pos += 1;
        let start = self.pos;
        while self.pos < self.src.len() && self.src[self.pos] != b'}' {
            self.pos += 1;
        }
        if self.pos >= self.src.len() {
            return Err("unterminated field reference".to_owned());
        }
        let name = self.text(start, self.pos);
        self.pos += 1;
        Ok(self
            .values
            .get(name.as_str())
            .map_or(Value::Null, |v| (*v).clone()))
    }

    fn string(&mut self, quote: u8) -> std::result::Result<Value, String> {
        self.pos += 1;
        let start = self.pos;
        while self.pos < self.src.len() && self.src[self.pos] != quote {
            self.pos += 1;
        }
        if self.pos >= self.src.len() {
            return Err("unterminated string".to_owned());
        }
        let text = self.text(start, self.pos);
        self.pos += 1;
        Ok(Value::String(text))
    }

    fn number(&mut self) -> std::result::Result<Value, String> {
        let start = self.pos;
        while self.pos < self.src.len()
            && (self.src[self.pos].is_ascii_digit() || self.src[self.pos] == b'.')
        {
            self.pos += 1;
        }
        let text = self.text(start, self.pos);
        text.parse::<f64>()
            .map(number)
            .map_err(|_| format!("strconv.ParseFloat: parsing {text:?}: invalid syntax"))
    }

    fn identifier_or_call(&mut self) -> std::result::Result<Value, String> {
        let start = self.pos;
        while self.pos < self.src.len()
            && (is_ident_start(self.src[self.pos]) || self.src[self.pos].is_ascii_digit())
        {
            self.pos += 1;
        }
        let name = self.text(start, self.pos).to_lowercase();
        self.skip_spaces();
        if self.peek() != b'(' {
            return match name.as_str() {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                "null" => Ok(Value::Null),
                _ => Err(format!("unknown identifier {name:?}")),
            };
        }
        self.pos += 1;
        let mut args = Vec::new();
        self.skip_spaces();
        if self.peek() != b')' {
            loop {
                args.push(self.expression()?);
                self.skip_spaces();
                if self.peek() == b',' {
                    self.pos += 1;
                    continue;
                }
                break;
            }
        }
        if self.peek() != b')' {
            return Err(format!("expected ')' after {name} arguments"));
        }
        self.pos += 1;
        call(&name, &args)
    }
}

fn call(name: &str, args: &[Value]) -> std::result::Result<Value, String> {
    let single = |label: &str| -> std::result::Result<&Value, String> {
        match args {
            [value] => Ok(value),
            _ => Err(format!("{label}() expects 1 argument")),
        }
    };
    match name {
        "if" => match args {
            [condition, then, otherwise] => Ok(if to_bool(condition) {
                then.clone()
            } else {
                otherwise.clone()
            }),
            _ => Err("if() expects 3 arguments".to_owned()),
        },
        "concat" => Ok(Value::String(args.iter().map(to_text).collect())),
        "upper" => Ok(Value::String(to_text(single("upper")?).to_uppercase())),
        "lower" => Ok(Value::String(to_text(single("lower")?).to_lowercase())),
        // Length in bytes, as the legacy runtime counted it.
        "len" => Ok(number(to_text(single("len")?).len() as f64)),
        _ => Err(format!("unknown function {name:?}")),
    }
}

fn is_ident_start(ch: u8) -> bool {
    ch.is_ascii_alphabetic() || ch == b'_'
}

fn is_space(ch: u8) -> bool {
    matches!(ch, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c | 0x85 | 0xa0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn eval(expression: &str, values: Value) -> std::result::Result<Value, String> {
        compute_formula(expression, values.as_object().unwrap_or(&Map::new()))
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(eval("1 + 2 * 3", json!({})), Ok(json!(7)));
        assert_eq!(eval("(1 + 2) * 3", json!({})), Ok(json!(9)));
        assert_eq!(eval("-{a} / 4", json!({"a": 10})), Ok(json!(-2.5)));
        assert_eq!(eval("1 / 0", json!({})), Err("division by zero".to_owned()));
    }

    #[test]
    fn strings_and_functions() {
        assert_eq!(
            eval(
                "{first} + ' ' + {last}",
                json!({"first": "Ada", "last": "L"})
            ),
            Ok(json!("Ada L"))
        );
        assert_eq!(eval("concat({n}, 'x')", json!({"n": 2.0})), Ok(json!("2x")));
        assert_eq!(eval("UPPER('abc')", json!({})), Ok(json!("ABC")));
        assert_eq!(eval("len('héllo')", json!({})), Ok(json!(6)));
        assert_eq!(
            eval("if({done}, 'yes', 'no')", json!({"done": true})),
            Ok(json!("yes"))
        );
        assert_eq!(
            eval("if({done}, 'yes', 'no')", json!({"done": "false"})),
            Ok(json!("no"))
        );
        assert_eq!(eval("{missing} + 1", json!({})), Ok(json!(1)));
    }

    #[test]
    fn errors() {
        assert!(eval("1 +", json!({})).is_err());
        assert!(eval("nope", json!({})).is_err());
        assert!(eval("foo(1)", json!({})).is_err());
        assert!(eval("'open", json!({})).is_err());
        assert!(eval("1 2", json!({})).is_err());
        assert_eq!(eval("", json!({})), Ok(Value::Null));
    }

    #[test]
    fn aggregations() {
        let values = [json!(1), json!("2"), json!(true)];
        assert_eq!(aggregate("count", &values), json!(3));
        assert_eq!(aggregate("sum", &values), json!(4));
        assert_eq!(aggregate("max", &values), json!(2));
        assert_eq!(aggregate("min", &[]), json!(0));
        assert_eq!(aggregate("and", &values), json!(true));
        assert_eq!(aggregate("and", &[]), json!(false));
        assert_eq!(aggregate("concat", &values), json!("1, 2, true"));
        assert_eq!(aggregate("nope", &values), Value::Null);
    }
}
