//! The filter expression language:
//!
//! ```text
//! expr    := or
//! or      := and ("or" and)*
//! and     := not ("and" not)*
//! not     := "not" not | cmp
//! cmp     := primary [op primary]
//! op      := == != > >= < <= contains startsWith endsWith in
//! primary := literal | call | field | "(" expr ")"
//! ```
//!
//! Values are JSON values; error texts match the legacy runtime.

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime};
use serde_json::{Map, Value};

use crate::gofmt::{format_float, format_layout, quote, quote_byte};

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Bool(bool),
    Num(f64),
    Str(String),
    Null,
    Field(String),
    Call(String, Vec<Expr>),
    Binary(String, Box<Expr>, Box<Expr>),
    Logic(String, Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub pos: usize,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "expr: {} (col {})", self.message, self.pos)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalError(pub String);

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "expr: {}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Eof,
    Ident,
    Number,
    Str,
    LParen,
    RParen,
    Comma,
    Dot,
    Bool,
    Null,
    Op,
    WordOp,
    Logic,
    Not,
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    text: String,
    pos: usize,
}

impl Token {
    fn eof(pos: usize) -> Self {
        Self {
            kind: Kind::Eof,
            text: String::new(),
            pos,
        }
    }
}

struct Lexer<'a> {
    src: &'a [u8],
    pos: usize,
}

fn parse_error(message: impl Into<String>, pos: usize) -> ParseError {
    ParseError {
        message: message.into(),
        pos,
    }
}

impl Lexer<'_> {
    fn peek(&self, offset: usize) -> u8 {
        self.src.get(self.pos + offset).copied().unwrap_or(0)
    }

    fn token(&mut self, kind: Kind, len: usize) -> Token {
        let start = self.pos;
        self.pos += len;
        Token {
            kind,
            text: String::from_utf8_lossy(&self.src[start..self.pos]).into_owned(),
            pos: start,
        }
    }

    fn next(&mut self) -> Result<Token, ParseError> {
        // Whitespace per byte, like the legacy lexer (ASCII and Latin-1 spaces).
        while self.pos < self.src.len() && is_space_byte(self.src[self.pos]) {
            self.pos += 1;
        }
        if self.pos >= self.src.len() {
            return Ok(Token::eof(self.pos));
        }
        let start = self.pos;
        let c = self.src[self.pos];
        Ok(match c {
            b'(' => self.token(Kind::LParen, 1),
            b')' => self.token(Kind::RParen, 1),
            b',' => self.token(Kind::Comma, 1),
            b'.' => self.token(Kind::Dot, 1),
            b'"' => return self.read_string(),
            b'=' | b'!' if self.peek(1) == b'=' => self.token(Kind::Op, 2),
            b'>' | b'<' if self.peek(1) == b'=' => self.token(Kind::Op, 2),
            b'>' | b'<' => self.token(Kind::Op, 1),
            b'-' | b'0'..=b'9' => {
                if c == b'-' {
                    self.pos += 1;
                }
                while self.pos < self.src.len()
                    && (self.src[self.pos].is_ascii_digit() || self.src[self.pos] == b'.')
                {
                    self.pos += 1;
                }
                Token {
                    kind: Kind::Number,
                    text: String::from_utf8_lossy(&self.src[start..self.pos]).into_owned(),
                    pos: start,
                }
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                while self.pos < self.src.len()
                    && (self.src[self.pos].is_ascii_alphanumeric() || self.src[self.pos] == b'_')
                {
                    self.pos += 1;
                }
                let text = String::from_utf8_lossy(&self.src[start..self.pos]).into_owned();
                let kind = match text.as_str() {
                    "true" | "false" => Kind::Bool,
                    "null" => Kind::Null,
                    "and" | "or" => Kind::Logic,
                    "not" => Kind::Not,
                    "contains" | "startsWith" | "endsWith" | "in" => Kind::WordOp,
                    _ => Kind::Ident,
                };
                Token {
                    kind,
                    text,
                    pos: start,
                }
            }
            c => {
                return Err(parse_error(
                    format!("unexpected character {}", quote_byte(c)),
                    start,
                ));
            }
        })
    }

    fn read_string(&mut self) -> Result<Token, ParseError> {
        let start = self.pos;
        self.pos += 1;
        let mut bytes = Vec::new();
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c == b'\\' && self.pos + 1 < self.src.len() {
                let next = self.src[self.pos + 1];
                bytes.push(match next {
                    b'n' => b'\n',
                    b't' => b'\t',
                    other => other,
                });
                self.pos += 2;
                continue;
            }
            if c == b'"' {
                self.pos += 1;
                return Ok(Token {
                    kind: Kind::Str,
                    text: String::from_utf8_lossy(&bytes).into_owned(),
                    pos: start,
                });
            }
            bytes.push(c);
            self.pos += 1;
        }
        Err(parse_error("unterminated string literal", start))
    }
}

/// `unicode.IsSpace` applied to a single byte read as a code point.
fn is_space_byte(c: u8) -> bool {
    matches!(c, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ' | 0x85 | 0xa0)
}

struct Parser<'a> {
    lexer: Lexer<'a>,
    cur: Token,
    next: Token,
}

/// Parses an expression; blank input is the constant `true`.
pub fn parse(source: &str) -> Result<Expr, ParseError> {
    let source = source.trim();
    if source.is_empty() {
        return Ok(Expr::Bool(true));
    }
    let mut parser = Parser {
        lexer: Lexer {
            src: source.as_bytes(),
            pos: 0,
        },
        cur: Token::eof(0),
        next: Token::eof(0),
    };
    parser.advance()?;
    parser.advance()?;
    let out = parser.parse_or()?;
    if parser.cur.kind != Kind::Eof {
        return Err(parse_error(
            format!("unexpected trailing token {}", quote(&parser.cur.text)),
            parser.cur.pos,
        ));
    }
    Ok(out)
}

impl Parser<'_> {
    fn advance(&mut self) -> Result<(), ParseError> {
        let next = self.lexer.next()?;
        self.cur = std::mem::replace(&mut self.next, next);
        Ok(())
    }

    fn parse_or(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_and()?;
        while self.cur.kind == Kind::Logic && self.cur.text == "or" {
            self.advance()?;
            let right = self.parse_and()?;
            left = Expr::Logic("or".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_not()?;
        while self.cur.kind == Kind::Logic && self.cur.text == "and" {
            self.advance()?;
            let right = self.parse_not()?;
            left = Expr::Logic("and".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_not(&mut self) -> Result<Expr, ParseError> {
        if self.cur.kind == Kind::Not {
            self.advance()?;
            return Ok(Expr::Not(Box::new(self.parse_not()?)));
        }
        self.parse_cmp()
    }

    fn parse_cmp(&mut self) -> Result<Expr, ParseError> {
        let left = self.parse_primary()?;
        if matches!(self.cur.kind, Kind::Op | Kind::WordOp) {
            let op = self.cur.text.clone();
            self.advance()?;
            let right = self.parse_primary()?;
            return Ok(Expr::Binary(op, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<Expr, ParseError> {
        let out = match self.cur.kind {
            Kind::Number => match parse_go_float(&self.cur.text) {
                Some(value) => Expr::Num(value),
                None => return Err(parse_error("invalid number", self.cur.pos)),
            },
            Kind::Str => Expr::Str(self.cur.text.clone()),
            Kind::Bool => Expr::Bool(self.cur.text == "true"),
            Kind::Null => Expr::Null,
            Kind::LParen => {
                self.advance()?;
                let inner = self.parse_or()?;
                if self.cur.kind != Kind::RParen {
                    return Err(parse_error("missing )", self.cur.pos));
                }
                self.advance()?;
                return Ok(inner);
            }
            Kind::Ident => return self.parse_field_or_call(),
            _ => {
                return Err(parse_error(
                    format!("unexpected token {}", quote(&self.cur.text)),
                    self.cur.pos,
                ));
            }
        };
        self.advance()?;
        Ok(out)
    }

    fn parse_field_or_call(&mut self) -> Result<Expr, ParseError> {
        let mut path = self.cur.text.clone();
        self.advance()?;
        while self.cur.kind == Kind::Dot {
            self.advance()?;
            if !matches!(self.cur.kind, Kind::Ident | Kind::Number) {
                return Err(parse_error("expected identifier after '.'", self.cur.pos));
            }
            path.push('.');
            path.push_str(&self.cur.text);
            self.advance()?;
        }
        if self.cur.kind != Kind::LParen {
            return Ok(Expr::Field(path));
        }
        self.advance()?;
        let mut args = Vec::new();
        if self.cur.kind != Kind::RParen {
            loop {
                args.push(self.parse_or()?);
                if self.cur.kind == Kind::Comma {
                    self.advance()?;
                    continue;
                }
                break;
            }
        }
        if self.cur.kind != Kind::RParen {
            return Err(parse_error("missing )", self.cur.pos));
        }
        self.advance()?;
        Ok(Expr::Call(path, args))
    }
}

/// `strconv.ParseFloat` for the lexer's number shapes (digits, dots, a
/// leading minus).
fn parse_go_float(text: &str) -> Option<f64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || digits == "." || digits.matches('.').count() > 1 {
        return None;
    }
    text.parse().ok()
}

/// Node outputs keyed by node ID; dotted paths walk nested objects.
pub type Env = Map<String, Value>;

fn lookup(env: &Env, path: &str) -> Option<Value> {
    let mut parts = path.split('.');
    let mut current = env.get(parts.next()?)?;
    for part in parts {
        current = current.as_object()?.get(part)?;
    }
    Some(current.clone())
}

pub fn eval(expr: &Expr, env: &Env) -> Result<Value, EvalError> {
    Ok(match expr {
        Expr::Bool(value) => Value::Bool(*value),
        Expr::Num(value) => number(*value),
        Expr::Str(value) => Value::String(value.clone()),
        Expr::Null => Value::Null,
        Expr::Field(path) => lookup(env, path).unwrap_or(Value::Null),
        Expr::Not(inner) => Value::Bool(!truthy(&eval(inner, env)?)),
        Expr::Logic(op, left, right) => {
            let l = truthy(&eval(left, env)?);
            if op == "and" && !l {
                return Ok(Value::Bool(false));
            }
            if op == "or" && l {
                return Ok(Value::Bool(true));
            }
            let r = truthy(&eval(right, env)?);
            Value::Bool(if op == "and" { l && r } else { l || r })
        }
        Expr::Binary(op, left, right) => {
            let l = eval(left, env)?;
            let r = eval(right, env)?;
            binary(op, &l, &r)?
        }
        Expr::Call(name, args) => {
            let values = args
                .iter()
                .map(|a| eval(a, env))
                .collect::<Result<Vec<_>, _>>()?;
            call(name, &values)?
        }
    })
}

/// Evaluates and coerces to a boolean.
pub fn eval_bool(expr: &Expr, env: &Env) -> Result<bool, EvalError> {
    Ok(truthy(&eval(expr, env)?))
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse().ok().filter(|_| !text.trim().is_empty()),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// `fmt.Sprint`-style text for any value.
fn to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => match n.as_i64() {
            Some(int) if n.is_i64() => int.to_string(),
            _ => format_float(n.as_f64().unwrap_or(0.0)),
        },
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(sprint).collect::<Vec<_>>().join(" ")
        ),
        Value::Object(_) => sprint(value),
    }
}

fn sprint(value: &Value) -> String {
    match value {
        Value::Null => "<nil>".into(),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let items: Vec<String> = keys
                .iter()
                .map(|k| format!("{k}:{}", sprint(&map[*k])))
                .collect();
            format!("map[{}]", items.join(" "))
        }
        Value::Number(n) if !n.is_i64() => {
            // Default %v of a float uses the shortest representation.
            let f = n.as_f64().unwrap_or(0.0);
            if f.abs() >= 1e21 || (f != 0.0 && f.abs() < 1e-4) {
                format!("{f:e}").replace("e", "e+").replace("e+-", "e-")
            } else {
                format_float(f)
            }
        }
        other => to_text(other),
    }
}

fn equal(left: &Value, right: &Value) -> bool {
    if left.is_null() || right.is_null() {
        return left.is_null() && right.is_null();
    }
    if let (Some(l), Some(r)) = (to_number(left), to_number(right)) {
        return l == r;
    }
    to_text(left) == to_text(right)
}

fn binary(op: &str, left: &Value, right: &Value) -> Result<Value, EvalError> {
    let result = match op {
        "==" => equal(left, right),
        "!=" => !equal(left, right),
        ">" | ">=" | "<" | "<=" => match (to_number(left), to_number(right)) {
            (Some(l), Some(r)) => match op {
                ">" => l > r,
                ">=" => l >= r,
                "<" => l < r,
                _ => l <= r,
            },
            _ => {
                let (l, r) = (to_text(left), to_text(right));
                match op {
                    ">" => l > r,
                    ">=" => l >= r,
                    "<" => l < r,
                    _ => l <= r,
                }
            }
        },
        "contains" => to_text(left).contains(&to_text(right)),
        "startsWith" => to_text(left).starts_with(&to_text(right)),
        "endsWith" => to_text(left).ends_with(&to_text(right)),
        "in" => match right {
            Value::Array(items) => items.iter().any(|item| equal(left, item)),
            Value::String(list) => {
                let needle = to_text(left);
                list.split(',').any(|item| item.trim() == needle)
            }
            _ => return Err(EvalError(format!("unsupported op {}", quote(op)))),
        },
        _ => return Err(EvalError(format!("unsupported op {}", quote(op)))),
    };
    Ok(Value::Bool(result))
}

fn expect(args: &[Value], name: &str) -> Result<(), EvalError> {
    if args.len() == 1 {
        Ok(())
    } else {
        Err(EvalError(format!("{name} expects 1 argument")))
    }
}

fn call(name: &str, args: &[Value]) -> Result<Value, EvalError> {
    match name {
        "str.upper" => {
            expect(args, name)?;
            Ok(Value::String(to_text(&args[0]).to_uppercase()))
        }
        "str.lower" => {
            expect(args, name)?;
            Ok(Value::String(to_text(&args[0]).to_lowercase()))
        }
        "str.trim" => {
            expect(args, name)?;
            Ok(Value::String(to_text(&args[0]).trim().to_owned()))
        }
        "len" => {
            expect(args, name)?;
            Ok(number(match &args[0] {
                Value::String(text) => text.len() as f64,
                Value::Array(items) => items.len() as f64,
                _ => 0.0,
            }))
        }
        "coalesce" => Ok(args
            .iter()
            .find(|v| !v.is_null() && v.as_str() != Some(""))
            .cloned()
            .unwrap_or(Value::Null)),
        "date.format" => {
            if args.len() < 2 {
                return Err(EvalError("date.format expects (value, format)".into()));
            }
            let time = parse_time(&to_text(&args[0]))?;
            Ok(Value::String(format_layout(
                &time,
                &translate_layout(&to_text(&args[1])),
            )))
        }
        "field" => {
            expect(args, name)?;
            Ok(args[0].clone())
        }
        _ => Err(EvalError(format!("unknown function {}", quote(name)))),
    }
}

fn parse_time(text: &str) -> Result<DateTime<FixedOffset>, EvalError> {
    let utc = |naive: NaiveDateTime| naive.and_utc().fixed_offset();
    if let Ok(time) = DateTime::parse_from_rfc3339(text) {
        return Ok(time);
    }
    for layout in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, layout) {
            return Ok(utc(naive));
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Ok(utc(date.and_hms_opt(0, 0, 0).unwrap_or_default()));
    }
    Err(EvalError(format!("date.format: unparseable date {text}")))
}

/// Maps `YYYY-MM-DD HH:mm:ss` style tokens (and `full`) to the reference
/// layout.
fn translate_layout(input: &str) -> String {
    if input == "full" {
        return "2006-01-02 15:04:05".into();
    }
    let mut out = input.to_owned();
    for (from, to) in [
        ("YYYY", "2006"),
        ("YY", "06"),
        ("MM", "01"),
        ("DD", "02"),
        ("HH", "15"),
        ("mm", "04"),
        ("ss", "05"),
    ] {
        out = out.replace(from, to);
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn env() -> Env {
        json!({"t": {"priority": "high", "n": 3, "tags": ["a", "b"], "when": "2026-03-05T14:07:09+08:00"}})
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn check(source: &str) -> Result<Value, String> {
        let parsed = parse(source).map_err(|e| e.to_string())?;
        eval(&parsed, &env()).map_err(|e| e.to_string())
    }

    #[test]
    fn evaluates_filters() {
        assert_eq!(
            check("t.priority == \"high\" and t.n >= 3"),
            Ok(json!(true))
        );
        assert_eq!(check("not (t.n < 2) or false"), Ok(json!(true)));
        assert_eq!(check("t.missing == null"), Ok(json!(true)));
        assert_eq!(check("\"b\" in t.tags"), Ok(json!(true)));
        assert_eq!(check("\"x\" in \"y, x\""), Ok(json!(true)));
        assert_eq!(check("t.priority startsWith \"hi\""), Ok(json!(true)));
        assert_eq!(check("\"10\" > \"9\""), Ok(json!(true)));
        assert_eq!(check("\"b\" > \"a\""), Ok(json!(true)));
        assert_eq!(check("str.upper(t.priority)"), Ok(json!("HIGH")));
        assert_eq!(check("len(t.tags)"), Ok(json!(2.0)));
        assert_eq!(check("coalesce(t.none, \"\", \"x\")"), Ok(json!("x")));
        assert_eq!(
            check("date.format(t.when, \"YYYY/MM/DD HH:mm\")"),
            Ok(json!("2026/03/05 14:07"))
        );
        assert_eq!(check(""), Ok(json!(true)));
    }

    #[test]
    fn reports_errors_like_the_legacy_runtime() {
        assert_eq!(
            check("t.x == #"),
            Err("expr: unexpected character '#' (col 7)".into())
        );
        assert_eq!(check("(t.x"), Err("expr: missing ) (col 4)".into()));
        assert_eq!(
            check("t.x == \"a"),
            Err("expr: unterminated string literal (col 7)".into())
        );
        assert_eq!(
            check("1 2"),
            Err("expr: unexpected trailing token \"2\" (col 2)".into())
        );
        assert_eq!(
            check("t."),
            Err("expr: expected identifier after '.' (col 2)".into())
        );
        assert_eq!(
            check("== 1"),
            Err("expr: unexpected token \"==\" (col 0)".into())
        );
        assert_eq!(
            check("1..2 == 1"),
            Err("expr: invalid number (col 0)".into())
        );
        assert_eq!(check("t.n in 3"), Err("expr: unsupported op \"in\"".into()));
        assert_eq!(
            check("nope(1)"),
            Err("expr: unknown function \"nope\"".into())
        );
        assert_eq!(
            check("str.upper()"),
            Err("expr: str.upper expects 1 argument".into())
        );
        assert_eq!(
            check("date.format(\"x\", \"YYYY\")"),
            Err("expr: date.format: unparseable date x".into())
        );
    }
}
