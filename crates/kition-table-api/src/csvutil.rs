//! CSV matching the legacy encoder: `\n` line endings, and fields quoted
//! only when they contain a comma, quote, CR, or LF, or start with
//! whitespace.

pub fn write_record(out: &mut String, fields: &[String]) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        if needs_quotes(field) {
            out.push('"');
            out.push_str(&field.replace('"', "\"\""));
            out.push('"');
        } else {
            out.push_str(field);
        }
    }
    out.push('\n');
}

fn needs_quotes(field: &str) -> bool {
    if field.is_empty() {
        return false;
    }
    if field == "\\." || field.contains([',', '"', '\r', '\n']) {
        return true;
    }
    field.chars().next().is_some_and(char::is_whitespace)
}

/// Parses CSV where every record must have as many fields as the first.
pub fn read_all(content: &str) -> Option<Vec<Vec<String>>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(false)
        .from_reader(content.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.ok()?;
        rows.push(record.iter().map(str::to_owned).collect());
    }
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_like_legacy_encoder() {
        let mut out = String::new();
        write_record(
            &mut out,
            &[
                "a".into(),
                "b,c".into(),
                "say \"hi\"".into(),
                " lead".into(),
                String::new(),
            ],
        );
        assert_eq!(out, "a,\"b,c\",\"say \"\"hi\"\"\",\" lead\",\n");
    }

    #[test]
    fn reads_rectangular_csv() {
        assert_eq!(
            read_all("a,b\n1,\"2,3\"\n"),
            Some(vec![
                vec!["a".into(), "b".into()],
                vec!["1".into(), "2,3".into()]
            ])
        );
        assert_eq!(read_all("a,b\n1\n"), None);
        assert_eq!(read_all(""), Some(Vec::new()));
    }
}
