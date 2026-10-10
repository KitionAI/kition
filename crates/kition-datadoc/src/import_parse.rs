//! Parsing import sources (CSV, TSV, XLSX) into rows and inferring a schema.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::OnceLock;

use calamine::{Data, Reader, SheetVisible, Xlsx};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

pub const SAMPLE_LIMIT: usize = 20;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ImportSource {
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub upload_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportWarning {
    pub code: String,
    pub message: String,
    pub severity: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub row: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub column: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportField {
    pub index: usize,
    pub title: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
    pub sample_values: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportSheet {
    pub name: String,
    pub index: usize,
    pub hidden: bool,
    pub row_count: usize,
    pub field_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportPreview {
    pub import_token: String,
    pub expires_at: i64,
    pub source: ImportSource,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub filename: String,
    pub format: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub encoding: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub delimiter: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub selected_sheet: String,
    pub row_count: usize,
    pub field_count: usize,
    pub fields: Vec<ImportField>,
    pub sample_rows: Vec<Vec<Value>>,
    pub warnings: Vec<ImportWarning>,
    pub sheets: Vec<ImportSheet>,
}

fn date_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$").unwrap_or_else(|err| panic!("{err}"))
    })
}

fn datetime_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$")
            .unwrap_or_else(|err| panic!("{err}"))
    })
}

/// Parses a source file by extension into a preview (without token).
pub fn parse(
    filename: &str,
    source: ImportSource,
    selected_sheet: &str,
    raw: &[u8],
) -> Result<ImportPreview, String> {
    let extension = std::path::Path::new(filename)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    match extension.as_str() {
        ".csv" | ".tsv" => {
            let (rows, delimiter) = parse_delimited(raw, &extension)?;
            Ok(build_preview(
                source,
                filename,
                &extension[1..],
                "utf-8",
                &delimiter,
                "",
                rows,
                Vec::new(),
            ))
        }
        ".xlsx" => {
            let (rows, sheet, sheets) = parse_workbook(raw, selected_sheet)?;
            Ok(build_preview(
                source, filename, "xlsx", "", "", &sheet, rows, sheets,
            ))
        }
        ".xls" => Err(
            "Legacy XLS files are not supported; save the workbook as XLSX and retry".to_owned(),
        ),
        _ => Err("Only CSV, TSV, and XLSX files can be imported".to_owned()),
    }
}

/// The normalized data rows (header first) for the preview's source.
pub fn data_rows(raw: &[u8], filename: &str, selected_sheet: &str) -> Vec<Vec<String>> {
    let lower = filename.to_lowercase();
    if lower.ends_with(".xlsx") {
        return parse_workbook(raw, selected_sheet)
            .map(|(rows, _, _)| normalize_rows(&rows))
            .unwrap_or_default();
    }
    let extension = if lower.ends_with(".tsv") {
        ".tsv"
    } else {
        ".csv"
    };
    parse_delimited(raw, extension)
        .map(|(rows, _)| normalize_rows(&rows))
        .unwrap_or_default()
}

pub fn parse_delimited(raw: &[u8], extension: &str) -> Result<(Vec<Vec<String>>, String), String> {
    let content = std::str::from_utf8(raw)
        .map_err(|_| "CSV and TSV imports must use UTF-8 encoding".to_owned())?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let delimiters: [u8; 3] = if extension == ".tsv" {
        *b"\t,;"
    } else {
        *b",\t;"
    };
    // A delimiter must beat -1, the score of a source without data rows.
    let (mut best_score, mut rows, mut delimiter) = (-1.0, Vec::new(), b',');
    for candidate in delimiters {
        let parsed = parse_tolerant(content, candidate);
        let score = score_rows(&parsed);
        if score > best_score {
            best_score = score;
            rows = parsed;
            delimiter = candidate;
        }
    }
    if rows.is_empty() {
        return Err("invalid delimited file".to_owned());
    }
    for row in &mut rows {
        for value in row.iter_mut() {
            *value = value.trim().to_owned();
        }
    }
    Ok((rows, char::from(delimiter).to_string()))
}

/// RFC 4180-ish parsing that never fails: quotes open only at the start of
/// a field, `""` escapes a quote, CR, LF, and CRLF end a row.
fn parse_tolerant(content: &str, delimiter: u8) -> Vec<Vec<String>> {
    let bytes = content.as_bytes();
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut value: Vec<u8> = Vec::new();
    let mut quoted = false;
    let mut index = 0;
    let finish_value = |row: &mut Vec<String>, value: &mut Vec<u8>| {
        row.push(String::from_utf8_lossy(value).into_owned());
        value.clear();
    };
    while index < bytes.len() {
        let ch = bytes[index];
        if quoted {
            if ch == b'"' {
                if bytes.get(index + 1) == Some(&b'"') {
                    value.push(b'"');
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                value.push(ch);
            }
        } else if ch == b'"' && String::from_utf8_lossy(&value).trim().is_empty() {
            quoted = true;
        } else if ch == delimiter {
            finish_value(&mut row, &mut value);
        } else if ch == b'\n' || ch == b'\r' {
            if ch == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            finish_value(&mut row, &mut value);
            rows.push(std::mem::take(&mut row));
        } else {
            value.push(ch);
        }
        index += 1;
    }
    if !value.is_empty() || !row.is_empty() {
        finish_value(&mut row, &mut value);
        rows.push(row);
    }
    rows
}

fn row_blank(row: &[String]) -> bool {
    row.iter().all(|value| value.trim().is_empty())
}

/// Favors delimiters that give many rows the same (wide) width.
fn score_rows(rows: &[Vec<String>]) -> f64 {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    let mut total = 0;
    for row in rows {
        if total >= 100 || row_blank(row) {
            continue;
        }
        *counts.entry(row.len()).or_default() += 1;
        total += 1;
    }
    if total == 0 {
        return -1.0;
    }
    let (mut mode_width, mut mode_count) = (0, 0);
    for (width, count) in counts {
        if count > mode_count || (count == mode_count && width > mode_width) {
            mode_width = width;
            mode_count = count;
        }
    }
    if mode_width <= 1 {
        return mode_count as f64 - 1000.0;
    }
    mode_count as f64 / total as f64 * 1000.0 + mode_width.min(100) as f64
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(text) | Data::DateTimeIso(text) | Data::DurationIso(text) => text.clone(),
        Data::Int(value) => value.to_string(),
        Data::Float(value) => crate::import_write::format_float(*value),
        Data::Bool(true) => "TRUE".to_owned(),
        Data::Bool(false) => "FALSE".to_owned(),
        Data::Error(error) => format!("{error}"),
        Data::DateTime(value) => match value.as_datetime() {
            Some(datetime) if datetime.time() == chrono::NaiveTime::MIN => {
                datetime.format("%Y-%m-%d").to_string()
            }
            Some(datetime) => datetime.format("%Y-%m-%d %H:%M:%S").to_string(),
            None => value.as_f64().to_string(),
        },
    }
}

/// A workbook sheet's rows, its name, and every sheet's summary.
pub type ParsedWorkbook = (Vec<Vec<String>>, String, Vec<ImportSheet>);

/// Rows of the selected (or first visible) sheet, laid out from cell A1.
pub fn parse_workbook(raw: &[u8], selected: &str) -> Result<ParsedWorkbook, String> {
    let mut workbook: Xlsx<_> = calamine::open_workbook_from_rs(Cursor::new(raw.to_vec()))
        .map_err(|_| "invalid XLSX workbook".to_owned())?;
    let metadata = workbook.sheets_metadata().to_vec();
    if metadata.is_empty() {
        return Err("workbook does not contain any sheets".to_owned());
    }
    let mut sheets = Vec::with_capacity(metadata.len());
    let mut all_rows: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    let mut default_sheet = String::new();
    for (index, sheet) in metadata.iter().enumerate() {
        let visible = matches!(sheet.visible, SheetVisible::Visible);
        let range = workbook
            .worksheet_range(&sheet.name)
            .map_err(|_| "failed to read workbook sheet".to_owned())?;
        let mut rows: Vec<Vec<String>> = Vec::new();
        if let Some((start_row, start_col)) = range.start() {
            for _ in 0..start_row {
                rows.push(Vec::new());
            }
            for range_row in range.rows() {
                let mut row = vec![String::new(); start_col as usize];
                row.extend(range_row.iter().map(cell_text));
                while row.last().is_some_and(String::is_empty) {
                    row.pop();
                }
                rows.push(row);
            }
            while rows.last().is_some_and(Vec::is_empty) {
                rows.pop();
            }
        }
        let field_count = rows.iter().map(Vec::len).max().unwrap_or(0);
        sheets.push(ImportSheet {
            name: sheet.name.clone(),
            index,
            hidden: !visible,
            row_count: rows.len().saturating_sub(1),
            field_count,
        });
        if default_sheet.is_empty() && visible {
            default_sheet = sheet.name.clone();
        }
        all_rows.insert(sheet.name.clone(), rows);
    }
    if default_sheet.is_empty() {
        default_sheet = metadata[0].name.clone();
    }
    let selected = if selected.trim().is_empty() {
        default_sheet
    } else {
        selected.to_owned()
    };
    let rows = all_rows
        .remove(&selected)
        .ok_or_else(|| "selected workbook sheet does not exist".to_owned())?;
    Ok((rows, selected, sheets))
}

/// Trims cells, pads rows to the widest non-blank column, drops blank rows.
pub fn normalize_rows(rows: &[Vec<String>]) -> Vec<Vec<String>> {
    let columns = rows
        .iter()
        .filter_map(|row| {
            row.iter()
                .rposition(|v| !v.trim().is_empty())
                .map(|i| i + 1)
        })
        .max()
        .unwrap_or(0);
    if columns == 0 {
        return Vec::new();
    }
    rows.iter()
        .map(|row| {
            (0..columns)
                .map(|i| row.get(i).map_or(String::new(), |v| v.trim().to_owned()))
                .collect::<Vec<_>>()
        })
        .filter(|row| !row_blank(row))
        .collect()
}

fn unique_headers(headers: &[String]) -> Vec<String> {
    let mut used = HashSet::new();
    headers
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let base = match raw.trim() {
                "" => format!("Column {}", index + 1),
                trimmed => trimmed.to_owned(),
            };
            let mut title = base.clone();
            let mut suffix = 2;
            while used.contains(&title.to_lowercase()) {
                title = format!("{base} {suffix}");
                suffix += 1;
            }
            used.insert(title.to_lowercase());
            title
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_preview(
    source: ImportSource,
    filename: &str,
    format: &str,
    encoding: &str,
    delimiter: &str,
    selected_sheet: &str,
    raw_rows: Vec<Vec<String>>,
    sheets: Vec<ImportSheet>,
) -> ImportPreview {
    let mut preview = ImportPreview {
        import_token: String::new(),
        expires_at: 0,
        source,
        filename: filename.to_owned(),
        format: format.to_owned(),
        encoding: encoding.to_owned(),
        delimiter: delimiter.to_owned(),
        selected_sheet: selected_sheet.to_owned(),
        row_count: 0,
        field_count: 0,
        fields: Vec::new(),
        sample_rows: Vec::new(),
        warnings: Vec::new(),
        sheets,
    };
    let rows = normalize_rows(&raw_rows);
    if rows.is_empty() {
        preview.warnings.push(ImportWarning {
            code: "empty_source".into(),
            message: "The import source is empty".into(),
            severity: "error".into(),
            row: 0,
            column: 0,
        });
        return preview;
    }
    let headers = unique_headers(&rows[0]);
    let data = &rows[1..];
    for (index, title) in headers.iter().enumerate() {
        let values: Vec<&str> = data
            .iter()
            .map(|row| row.get(index).map_or("", String::as_str))
            .collect();
        let nullable = values.iter().any(|v| v.is_empty());
        let (field_type, options) = infer_field(&values);
        let sample_values = values
            .iter()
            .filter(|v| !v.is_empty())
            .take(SAMPLE_LIMIT)
            .map(|v| coerce_value(v, &field_type))
            .collect();
        preview.fields.push(ImportField {
            index,
            title: title.clone(),
            field_type,
            nullable,
            options,
            sample_values,
        });
    }
    preview.sample_rows = data
        .iter()
        .take(SAMPLE_LIMIT)
        .map(|row| {
            preview
                .fields
                .iter()
                .enumerate()
                .map(|(i, field)| match row.get(i) {
                    Some(v) if !v.is_empty() => coerce_value(v, &field.field_type),
                    _ => Value::Null,
                })
                .collect()
        })
        .collect();
    preview.row_count = data.len();
    preview.field_count = preview.fields.len();
    preview
}

fn infer_field(values: &[&str]) -> (String, Option<Map<String, Value>>) {
    let populated: Vec<&str> = values.iter().copied().filter(|v| !v.is_empty()).collect();
    if populated.is_empty() {
        return ("text".into(), None);
    }
    let checkbox_tokens: HashSet<String> = populated.iter().map(|v| v.to_lowercase()).collect();
    if checkbox_tokens
        .iter()
        .all(|t| matches!(t.as_str(), "true" | "false" | "yes" | "no"))
        && checkbox_tokens.len() <= 2
    {
        return ("checkbox".into(), None);
    }
    if populated.iter().all(|v| parse_float(v).is_some()) {
        return ("number".into(), None);
    }
    if populated.iter().all(|v| datetime_pattern().is_match(v)) {
        return ("datetime".into(), None);
    }
    if populated.iter().all(|v| date_pattern().is_match(v)) {
        return ("date".into(), None);
    }
    if populated.iter().all(|v| is_web_url(v)) {
        return ("url".into(), None);
    }
    let mut max_length = 0;
    let mut total_length = 0;
    for value in &populated {
        if value.contains('\n') {
            return ("long_text".into(), None);
        }
        let length = value.chars().count();
        max_length = max_length.max(length);
        total_length += length;
    }
    if max_length > 120 || total_length / populated.len() > 80 {
        return ("long_text".into(), None);
    }
    let unique: HashSet<&str> = populated.iter().copied().collect();
    if populated.len() >= 8
        && unique.len() <= 50
        && unique.len() as f64 / populated.len() as f64 <= 0.2
        && max_length <= 80
    {
        let mut seen = HashSet::new();
        let choices: Vec<Value> = populated
            .iter()
            .filter(|v| seen.insert(**v))
            .map(|v| Value::String((*v).to_owned()))
            .collect();
        let mut options = Map::new();
        options.insert("choices".into(), Value::Array(choices));
        return ("single_select".into(), Some(options));
    }
    ("text".into(), None)
}

/// Decimal or scientific notation, plus `inf`/`nan` spellings.
pub fn parse_float(value: &str) -> Option<f64> {
    value.parse::<f64>().ok()
}

fn is_web_url(value: &str) -> bool {
    url::Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty())
    })
}

/// The JSON value for one imported cell of the given field type.
pub fn coerce_value(value: &str, field_type: &str) -> Value {
    if value.is_empty() {
        return Value::Null;
    }
    match field_type {
        "number" => match parse_float(value) {
            Some(number) => crate::import_write::float_value(number),
            None => Value::String(value.to_owned()),
        },
        "checkbox" => {
            Value::Bool(value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes"))
        }
        "multi_select" => Value::Array(
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| Value::String(item.to_owned()))
                .collect(),
        ),
        _ => Value::String(value.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn detects_delimiters_and_quotes() {
        let (rows, delimiter) =
            parse_delimited("\u{feff}a;b;c\n1;\"x;y\";3\r\n4;5;6".as_bytes(), ".csv")
                .unwrap_or_default();
        assert_eq!(delimiter, ";");
        assert_eq!(rows[1], ["1", "x;y", "3"]);
        let (_, delimiter) = parse_delimited(b"a\tb\n1\t2\n", ".csv").unwrap_or_default();
        assert_eq!(delimiter, "\t");
        assert!(parse_delimited(&[0xff, 0xfe], ".csv").is_err());
    }

    #[test]
    fn infers_types() {
        let infer = |values: &[&str]| infer_field(values).0;
        assert_eq!(infer(&["1", "2.5", "-3e2"]), "number");
        assert_eq!(infer(&["yes", "No"]), "checkbox");
        assert_eq!(infer(&["2024-01-02", "2024/1/3"]), "date");
        assert_eq!(
            infer(&["2024-01-02 10:00", "2024-01-02T10:00:00Z"]),
            "datetime"
        );
        assert_eq!(infer(&["https://a.com", "http://b.org/x"]), "url");
        assert_eq!(infer(&["", ""]), "text");
        assert_eq!(infer(&["a\nb"]), "long_text");
        let statuses = [
            "Open", "Done", "Open", "Done", "Open", "Done", "Open", "Done", "Open", "Done",
        ];
        let (kind, options) = infer_field(&statuses);
        assert_eq!(kind, "single_select");
        assert_eq!(
            options.map(Value::Object),
            Some(json!({"choices": ["Open", "Done"]}))
        );
    }

    #[test]
    fn builds_preview_with_unique_headers() {
        let rows = vec![
            vec!["Name".into(), "name".into(), String::new()],
            vec!["a".into(), "1".into(), String::new()],
            vec![String::new(), String::new(), String::new()],
            vec!["b".into(), String::new(), String::new()],
        ];
        let preview = build_preview(
            ImportSource::default(),
            "x.csv",
            "csv",
            "utf-8",
            ",",
            "",
            rows,
            Vec::new(),
        );
        assert_eq!(
            preview
                .fields
                .iter()
                .map(|f| f.title.as_str())
                .collect::<Vec<_>>(),
            ["Name", "name 2"]
        );
        assert_eq!(preview.row_count, 2);
        assert_eq!(preview.fields[1].field_type, "number");
        assert!(preview.fields[1].nullable);
        assert_eq!(preview.sample_rows[0], vec![json!("a"), json!(1)]);
    }

    #[test]
    fn rejects_unknown_formats() {
        assert!(parse("a.xls", ImportSource::default(), "", b"").is_err());
        assert!(parse("a.txt", ImportSource::default(), "", b"").is_err());
        assert!(parse("a.xlsx", ImportSource::default(), "", b"not a zip").is_err());
    }
}
