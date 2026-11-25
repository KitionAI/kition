// Copied from kition-sdk crates/kition-kdm/src/store/text.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A text field: its characters in chunks, and its marks as runs (rule M19).
//!
//! Positions count Unicode scalar values. The characters are kept in chunks of about [`CHUNK`]
//! characters, each with its count, so an edit costs the number of chunks plus one chunk, not the
//! whole text: an edit on a 1 MB text costs about what one on 64 KB costs
//! (`tests/text_pieces.rs`). The marks are runs that cover the text: adjacent runs differ in their
//! marks, and no run is empty.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{Expand, TextRun};

/// A run's marks: mark key to value, never `null`.
pub(crate) type Marks = BTreeMap<String, Value>;

/// The characters a chunk is cut to; a chunk grows to twice that before it is cut again.
const CHUNK: usize = 1024;

#[derive(Clone, Debug, Default)]
pub(crate) struct Text {
    chunks: Vec<Chunk>,
    len: usize,
    runs: Vec<Run>,
}

#[derive(Clone, Debug)]
struct Chunk {
    text: String,
    chars: usize,
}

/// Characters that carry the same marks.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Run {
    pub(crate) len: usize,
    pub(crate) marks: Marks,
}

/// A range of characters and the value one mark key held over it (`null`: none), as
/// [`Text::mark`] answers them.
pub(crate) type MarkSegment = (usize, usize, Value);

impl PartialEq for Text {
    /// Texts are equal when their characters and runs are, however they are chunked.
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.runs == other.runs && self.string() == other.string()
    }
}

/// The byte offset of character `index` in `text` (its length when `index` is past the end).
fn byte_at(text: &str, chars: usize, index: usize) -> usize {
    if text.len() == chars {
        return index.min(text.len());
    }
    text.char_indices().nth(index).map_or(text.len(), |(at, _)| at)
}

/// `text` cut into chunks of [`CHUNK`] characters.
fn pieces(text: &str) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let cut = rest.char_indices().nth(CHUNK).map_or(rest.len(), |(at, _)| at);
        let (piece, tail) = rest.split_at(cut);
        out.push(Chunk { text: piece.to_owned(), chars: piece.chars().count() });
        rest = tail;
    }
    out
}

impl Text {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The whole text.
    pub(crate) fn string(&self) -> String {
        let mut out = String::with_capacity(self.chunks.iter().map(|chunk| chunk.text.len()).sum());
        for chunk in &self.chunks {
            out.push_str(&chunk.text);
        }
        out
    }

    /// A text of these runs (marks with `null` values dropped, empty runs dropped, adjacent runs
    /// with equal marks merged), in one pass: linear in the runs' length.
    pub(crate) fn from_runs(runs: &[TextRun]) -> Self {
        let mut whole = String::new();
        let mut merged: Vec<Run> = Vec::new();
        for run in runs {
            let len = run.insert.chars().count();
            if len == 0 {
                continue;
            }
            let marks: Marks = run.attributes.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())).collect();
            whole.push_str(&run.insert);
            match merged.last_mut() {
                Some(last) if last.marks == marks => last.len += len,
                _ => merged.push(Run { len, marks }),
            }
        }
        let len = merged.iter().map(|run| run.len).sum();
        Self { chunks: pieces(&whole), len, runs: merged }
    }

    /// A text without marks.
    pub(crate) fn plain(content: &str) -> Self {
        let mut text = Self::default();
        text.insert(0, content, Marks::new());
        text
    }

    /// The runs, in order.
    pub(crate) fn runs(&self) -> Vec<TextRun> {
        let whole = self.string();
        let mut out = Vec::with_capacity(self.runs.len());
        let mut rest = whole.as_str();
        for run in &self.runs {
            let cut = rest.char_indices().nth(run.len).map_or(rest.len(), |(at, _)| at);
            let (piece, tail) = rest.split_at(cut);
            out.push(TextRun { insert: piece.to_owned(), attributes: run.marks.clone() });
            rest = tail;
        }
        out
    }

    /// Whether any character carries a mark.
    pub(crate) fn has_marks(&self) -> bool {
        self.runs.iter().any(|run| !run.marks.is_empty())
    }

    /// The characters `start..end` (clamped to the text).
    pub(crate) fn slice(&self, start: usize, end: usize) -> String {
        let mut out = String::new();
        let mut at = 0;
        for chunk in &self.chunks {
            let (from, to) = (start.max(at), end.min(at + chunk.chars));
            if from < to {
                let (a, b) = (byte_at(&chunk.text, chunk.chars, from - at), byte_at(&chunk.text, chunk.chars, to - at));
                if let Some(piece) = chunk.text.get(a..b) {
                    out.push_str(piece);
                }
            }
            at += chunk.chars;
            if at >= end {
                break;
            }
        }
        out
    }

    /// The marks of the character at `index`.
    pub(crate) fn marks_at(&self, index: usize) -> Option<&Marks> {
        let mut at = 0;
        for run in &self.runs {
            if index < at + run.len {
                return Some(&run.marks);
            }
            at += run.len;
        }
        None
    }

    /// The marks text inserted at `index` takes from its neighbours: a key the character before
    /// holds when its expand is `after` or `both`, or when the character after holds the same
    /// value (inside a run); else a key the character after holds when its expand is `before` or
    /// `both`. `expand` answers a key's expand (`None` for a key the field does not declare).
    pub(crate) fn inserted_marks(&self, index: usize, expand: impl Fn(&str) -> Option<Expand>) -> Marks {
        let left = index.checked_sub(1).and_then(|before| self.marks_at(before));
        let right = if index < self.len { self.marks_at(index) } else { None };
        let mut out = Marks::new();
        let keys: std::collections::BTreeSet<&String> = left.into_iter().chain(right).flat_map(|marks| marks.keys()).collect();
        for key in keys {
            let grows = expand(key).unwrap_or(Expand::None);
            let (l, r) = (left.and_then(|marks| marks.get(key)), right.and_then(|marks| marks.get(key)));
            if let Some(value) = l
                && (matches!(grows, Expand::After | Expand::Both) || r == Some(value))
            {
                out.insert(key.clone(), value.clone());
            } else if let Some(value) = r
                && matches!(grows, Expand::Before | Expand::Both)
            {
                out.insert(key.clone(), value.clone());
            }
        }
        out
    }

    /// The chunk holding character `index` and the offset in it; at the end, the last chunk and
    /// its length.
    fn locate(&self, index: usize) -> (usize, usize) {
        let mut at = 0;
        for (number, chunk) in self.chunks.iter().enumerate() {
            if index < at + chunk.chars {
                return (number, index - at);
            }
            at += chunk.chars;
        }
        match self.chunks.last() {
            Some(last) => (self.chunks.len() - 1, last.chars),
            None => (0, 0),
        }
    }

    /// Inserts `content` at `index` (at most the length) with `marks`.
    pub(crate) fn insert(&mut self, index: usize, content: &str, marks: Marks) {
        let count = content.chars().count();
        if count == 0 {
            return;
        }
        let index = index.min(self.len);
        let (number, offset) = self.locate(index);
        match self.chunks.get_mut(number) {
            None => self.chunks = pieces(content),
            Some(chunk) if chunk.chars + count <= 2 * CHUNK => {
                let at = byte_at(&chunk.text, chunk.chars, offset);
                chunk.text.insert_str(at, content);
                chunk.chars += count;
            }
            Some(chunk) => {
                let at = byte_at(&chunk.text, chunk.chars, offset);
                let (head, tail) = chunk.text.split_at(at);
                let joined = [head, content, tail].concat();
                self.chunks.splice(number..=number, pieces(&joined));
            }
        }
        self.len += count;
        let at = self.split_runs(index);
        self.runs.insert(at, Run { len: count, marks });
        self.normalize();
    }

    /// Deletes `count` characters from `index`; answers them as runs.
    pub(crate) fn delete(&mut self, index: usize, count: usize) -> Vec<TextRun> {
        let end = index.saturating_add(count).min(self.len);
        if index >= end {
            return Vec::new();
        }
        let removed = self.slice(index, end);
        let first = self.split_runs(index);
        let last = self.split_runs(end);
        let runs: Vec<Run> = self.runs.drain(first..last).collect();
        let mut remaining = end - index;
        let (mut number, mut offset) = self.locate(index);
        while remaining > 0 {
            let Some(chunk) = self.chunks.get_mut(number) else { break };
            let available = chunk.chars - offset;
            if available == 0 {
                number += 1;
                offset = 0;
                continue;
            }
            let take = available.min(remaining);
            let (a, b) = (byte_at(&chunk.text, chunk.chars, offset), byte_at(&chunk.text, chunk.chars, offset + take));
            chunk.text.replace_range(a..b, "");
            chunk.chars -= take;
            remaining -= take;
            if chunk.chars == 0 {
                self.chunks.remove(number);
            } else {
                number += 1;
            }
            offset = 0;
        }
        self.len -= end - index;
        self.normalize();
        let mut out = Vec::with_capacity(runs.len());
        let mut rest = removed.as_str();
        for run in runs {
            let cut = rest.char_indices().nth(run.len).map_or(rest.len(), |(at, _)| at);
            let (piece, tail) = rest.split_at(cut);
            out.push(TextRun { insert: piece.to_owned(), attributes: run.marks });
            rest = tail;
        }
        out
    }

    /// Sets mark `key` to `value` over `start..end` (`null`: removes it). Answers what the key held
    /// over the range before, as consecutive segments with their values (`null`: none).
    pub(crate) fn mark(&mut self, start: usize, end: usize, key: &str, value: &Value) -> Vec<MarkSegment> {
        let end = end.min(self.len);
        if start >= end {
            return Vec::new();
        }
        let first = self.split_runs(start);
        let last = self.split_runs(end);
        let mut before: Vec<MarkSegment> = Vec::new();
        let mut at = start;
        for run in self.runs.iter_mut().take(last).skip(first) {
            let held = run.marks.get(key).cloned().unwrap_or(Value::Null);
            match before.last_mut() {
                Some(segment) if segment.2 == held => segment.1 = at + run.len,
                _ => before.push((at, at + run.len, held)),
            }
            at += run.len;
            if value.is_null() {
                run.marks.remove(key);
            } else {
                run.marks.insert(key.to_owned(), value.clone());
            }
        }
        self.normalize();
        before
    }

    /// Makes a run boundary at `index`; answers the number of the run that starts there (the
    /// number of runs, at the end).
    fn split_runs(&mut self, index: usize) -> usize {
        let mut at = 0;
        for number in 0..self.runs.len() {
            let Some(run) = self.runs.get_mut(number) else { break };
            if index == at {
                return number;
            }
            if index < at + run.len {
                let tail = Run { len: at + run.len - index, marks: run.marks.clone() };
                run.len = index - at;
                self.runs.insert(number + 1, tail);
                return number + 1;
            }
            at += run.len;
        }
        self.runs.len()
    }

    /// Drops empty runs and merges adjacent runs with equal marks.
    fn normalize(&mut self) {
        let mut merged: Vec<Run> = Vec::with_capacity(self.runs.len());
        for run in self.runs.drain(..) {
            if run.len == 0 {
                continue;
            }
            match merged.last_mut() {
                Some(last) if last.marks == run.marks => last.len += run.len,
                _ => merged.push(run),
            }
        }
        self.runs = merged;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn bold() -> Marks {
        [("bold".to_owned(), json!(true))].into_iter().collect()
    }

    #[test]
    fn inserts_and_deletes_across_chunks_keep_the_text_and_its_runs() {
        let long: String = (0..5_000).map(|n| if n % 7 == 0 { char::from_u32(0x5b57).unwrap_or(char::REPLACEMENT_CHARACTER) } else { 'a' }).collect();
        let mut text = Text::plain(&long);
        assert_eq!(text.len(), 5_000);
        assert!(text.chunks.len() >= 4);
        text.insert(2_500, "XY", bold());
        assert_eq!(text.len(), 5_002);
        assert_eq!(text.slice(2_499, 2_503), format!("{}XY{}", long.chars().nth(2_499).unwrap(), long.chars().nth(2_500).unwrap()));
        let removed = text.delete(1_000, 3_000);
        assert_eq!(removed.len(), 3);
        assert_eq!(removed.get(1), Some(&TextRun::new("XY").with("bold", json!(true))));
        assert_eq!(text.string(), [long.chars().take(1_000).collect::<String>(), long.chars().skip(3_998).collect()].concat());
        assert_eq!(text.runs().len(), 1);
    }

    #[test]
    fn marks_answer_what_they_replaced() {
        let mut text = Text::plain("abcdef");
        assert_eq!(text.mark(1, 3, "bold", &json!(true)), vec![(1, 3, Value::Null)]);
        assert_eq!(text.mark(0, 6, "bold", &Value::Null), vec![(0, 1, Value::Null), (1, 3, json!(true)), (3, 6, Value::Null)]);
        assert!(!text.has_marks());
        assert_eq!(text.runs(), vec![TextRun::new("abcdef")]);
    }

    #[test]
    fn inserted_text_takes_marks_by_their_expand() {
        let mut text = Text::plain("ab");
        text.mark(0, 1, "bold", &json!(true));
        text.mark(1, 2, "link", &json!("x"));
        let expand = |key: &str| match key {
            "bold" => Some(Expand::After),
            "link" => Some(Expand::None),
            _ => None,
        };
        // Between the bold `a` and the linked `b`: bold grows after; the link does not.
        assert_eq!(text.inserted_marks(1, expand), bold());
        // Inside a link run, the link holds on both sides.
        let mut link = Text::plain("abc");
        link.mark(0, 3, "link", &json!("x"));
        assert_eq!(link.inserted_marks(1, expand), [("link".to_owned(), json!("x"))].into_iter().collect());
        assert_eq!(link.inserted_marks(3, expand), Marks::new());
    }
}
