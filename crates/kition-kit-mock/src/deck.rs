// Copied from kition-sdk crates/kition-kit-mock/src/deck.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Documents as decks (`KITION_KIT_MOCK_PARTS=deck`): slides holding shapes, kept in an object
//! model whose tool ids survive edits and reloads, as a real slide kit's do. The file is the deck as
//! text, a slide a line:
//!
//! ```text
//! 1:1=Title|2=Body#red
//! 2:3=Notes
//! ```
//!
//! `1:` is the slide's number (its `slideId`, and its tool id `slide:1`), `1=Title` a shape
//! numbered 1 (tool id `shape:1`) with its text, `#red` its colour. Numbers are unique in the
//! deck and kept when objects move, so a test can change the file as someone else would and keep
//! the objects it does not touch. The object model is the document: commands and batches change
//! it, and the text is written from it.
//!
//! A text or colour holding one of the file's separators (`|`, `#`, a line break) would not read
//! back, so commands and batches refuse it ([`separators`]); a shape without text is an error
//! `document.check` reports ([`diagnostics`]).
//!
//! `KITION_KIT_MOCK_DECK=nested` models the deck as a real slide kit does ([`SCHEMA_NESTED`]), so
//! what only a real kit had cannot hide from tests:
//!
//! - a shape's number is unique only on its slide, and its tool id joins both
//!   (`shape:<slideId>/<n>`, from its read-only `key` `<slideId>/<n>`): `1=` on two slides are two
//!   shapes;
//! - a shape's text is in a text body it owns (`body`, a ref declared `owns`) holding paragraphs,
//!   neither with a tool id: `1:1=Title~Subtitle` is a shape whose body holds two paragraphs
//!   (`~` separates them);
//! - a slide holds notes whose tool ids start with the slide's (`slide:<slideId>/note:<n>`, a
//!   `toolId` with a `parent`): `1:1=Title|!1=Speak slowly`;
//! - the deck holds shared objects without tool ids that others point at with refs that do not
//!   own them: layouts (`layout Title=big`, a line of its own; a slide names its layout after its
//!   number, `1@Title:…`) and media (`media logo=PNG1`; a picture names it after its text,
//!   `2=Caption^logo`);
//! - object ids are not derived from the file: every read of it (an open, a reload) mints new
//!   ones, as a kit that builds its replica from its file must (Kition platform
//!   `docs/platform/data-model.md`, "Ids of a file opened again"). Only tool ids survive it, and
//!   the root, whose id is the same on every read (`deck`), as a real slide kit's is;
//! - object ids sit inside values that are not refs: a picture's `look` (json) names its medium
//!   (`{ "fill": { "media": <id> } }`), a slide's `props` (json) has its layout's id as a key
//!   (`{ "layouts": { <id>: { "follow": true } } }`);
//! - a table (`3%a,b;c,d`: a shape numbered 3 whose cells are `a`, `b` in the first row and `c`,
//!   `d` in the second; `,` separates cells, `;` rows) holds rows and columns without tool ids
//!   and its cells in an owning map keyed `<row id>:<column id>`, each cell's text in a body it
//!   owns, as a real slide kit's table does;
//! - a connector (`6>1,2`: a shape numbered 6 joining the shapes numbered 1 and 2 on its slide)
//!   names the shapes it joins by their OBJECT ids inside its `look` (json:
//!   `{ "kind": { "start": <id>, "end": <id> } }`), as a real slide kit's connectors do, though
//!   those shapes have tool ids; it has no text;
//! - the file may be written again unchanged in another form, as another program saves it: lines
//!   starting with `//` are comments, layout and media lines may come anywhere, and a line may end
//!   with `\r\n`.

use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, UndoScope};
use serde_json::{Map, Value, json};

/// The deck's object model: slides and shapes, both named by tool ids (KitObjectModel OM9).
pub const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Deck",
  "types": {
    "Deck": { "fields": { "slides": { "kind": "list", "of": "Slide" } } },
    "Slide": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "shapes": { "kind": "list", "of": "Shape" }
    }, "toolId": { "field": "number", "prefix": "slide:" } },
    "Shape": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "text": { "kind": "string" },
      "color": { "kind": "string", "optional": true }
    }, "toolId": { "field": "number", "prefix": "shape:" } }
  }
}"#;

/// The deck as a real slide kit models it (`KITION_KIT_MOCK_DECK=nested`): shapes numbered per
/// slide with composite tool ids, their text in an owned body of paragraphs, slide notes, and
/// layouts and media the deck holds, which slides and pictures point at.
pub const SCHEMA_NESTED: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Deck",
  "types": {
    "Deck": { "fields": {
      "layouts": { "kind": "list", "of": "Layout" },
      "media": { "kind": "list", "of": "Media" },
      "slides": { "kind": "list", "of": "Slide" }
    } },
    "Layout": { "fields": { "name": { "kind": "string" }, "look": { "kind": "string" } } },
    "Media": { "fields": { "name": { "kind": "string" }, "data": { "kind": "string" } } },
    "Slide": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "layout": { "kind": "ref", "of": "Layout", "optional": true },
      "props": { "kind": "json", "optional": true },
      "shapes": { "kind": "list", "of": "Shape" },
      "notes": { "kind": "list", "of": "Note" }
    }, "toolId": { "field": "number", "prefix": "slide:" } },
    "Shape": { "fields": {
      "key": { "kind": "string", "optional": true, "readOnly": true },
      "body": { "kind": "ref", "of": "TextBody", "optional": true, "owns": true },
      "table": { "kind": "ref", "of": "Table", "optional": true, "owns": true },
      "media": { "kind": "ref", "of": "Media", "optional": true },
      "look": { "kind": "json", "optional": true },
      "color": { "kind": "string", "optional": true }
    }, "toolId": { "field": "key", "prefix": "shape:" } },
    "Table": { "fields": {
      "rows": { "kind": "list", "of": "Row" },
      "cols": { "kind": "list", "of": "Col" },
      "cells": { "kind": "map", "owns": true }
    } },
    "Row": { "fields": {} },
    "Col": { "fields": {} },
    "TextBody": { "fields": { "paragraphs": { "kind": "list", "of": "Paragraph" } } },
    "Paragraph": { "fields": { "text": { "kind": "string" } } },
    "Note": { "fields": {
      "number": { "kind": "integer", "optional": true, "readOnly": true },
      "text": { "kind": "string" }
    }, "toolId": { "field": "number", "prefix": "note:", "parent": "Slide" } }
  }
}"#;

/// Whether decks are nested ([`SCHEMA_NESTED`]).
pub static NESTED: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_DECK").is_ok_and(|value| value.trim() == "nested"));

/// The deck's schema.
pub fn schema() -> &'static str {
    if *NESTED { SCHEMA_NESTED } else { SCHEMA }
}

/// What separates a shape's paragraphs in a nested deck's file.
const PARAGRAPHS: char = '~';

/// The id of the deck's root object.
const ROOT: &str = "deck";

/// A slide as the file holds it: its number and its shapes (number, text, colour).
type SlideLine = (u64, Vec<(u64, String, Option<String>)>);

/// The slides of a flat deck's text; a line that is no slide is an error.
fn parse(text: &str) -> Result<Vec<SlideLine>, String> {
    let mut slides = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (number, shapes) = line.split_once(':').ok_or_else(|| format!("`{line}` is no slide: `<number>:<shapes>`"))?;
        let number = number.trim().parse::<u64>().map_err(|_| format!("`{number}` is no slide number"))?;
        let mut parsed = Vec::new();
        for shape in shapes.split('|').filter(|shape| !shape.is_empty()) {
            let (n, rest) = shape.split_once('=').ok_or_else(|| format!("`{shape}` is no shape: `<number>=<text>[#colour]`"))?;
            let n = n.trim().parse::<u64>().map_err(|_| format!("`{n}` is no shape number"))?;
            let (text, color) = match rest.rsplit_once('#') {
                Some((text, color)) => (text.to_owned(), Some(color.to_owned())),
                None => (rest.to_owned(), None),
            };
            parsed.push((n, text, color));
        }
        slides.push((number, parsed));
    }
    Ok(slides)
}

/// A new deck replica from its text: objects keep the file's numbers. A flat deck's object ids are
/// made from them, so reading the same file twice gives the same objects; a nested deck's are new
/// on every read ([`build_nested`]).
pub fn build(text: &str) -> Result<Replica, String> {
    if *NESTED {
        return build_nested(text);
    }
    let slides = parse(text)?;
    let schema = Arc::new(Schema::parse(SCHEMA).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Deck", &ObjectId::from_string(ROOT), Map::new())?;
        for (at, (number, shapes)) in slides.iter().enumerate() {
            let slide =
                tx.create_with_id("Slide", &ObjectId::from_string(format!("slide-{number}")), Map::from_iter([("number".to_owned(), json!(number))]))?;
            tx.list_insert(&root, "slides", at, &slide)?;
            for (index, (n, text, color)) in shapes.iter().enumerate() {
                let mut fields = Map::from_iter([("number".to_owned(), json!(n)), ("text".to_owned(), json!(text))]);
                if let Some(color) = color {
                    fields.insert("color".into(), json!(color));
                }
                let shape = tx.create_with_id("Shape", &ObjectId::from_string(format!("shape-{n}")), fields)?;
                tx.list_insert(&slide, "shapes", index, &shape)?;
            }
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

/// Applies a flat deck's imported differences without replacing its live replica.
pub fn reread(replica: &mut Replica, text: &str) -> Result<(), String> {
    let fresh = build(text)?;
    let before = replica.state_json().map_err(|e| e.to_string())?;
    let after = fresh.state_json().map_err(|e| e.to_string())?;
    let old = before["objects"].as_object().ok_or("no old objects")?;
    let new = after["objects"].as_object().ok_or("no fresh objects")?;
    let schema = replica.schema().clone();
    replica
        .transact(&Origin::new(kition_kdm::OriginKind::Import, "file reread"), |tx| {
            for (id, object) in new {
                if !old.contains_key(id) {
                    let ty = object["$type"].as_str().unwrap();
                    let fields = object
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(field, _)| schema.field(ty, field).is_ok_and(|def| def.kind != kition_kdm::FieldKind::List))
                        .map(|(field, value)| (field.clone(), value.clone()))
                        .collect();
                    tx.create_with_id(ty, &ObjectId::from_string(id), fields)?;
                }
            }
            for (id, object) in new {
                let target = ObjectId::from_string(id);
                let ty = object["$type"].as_str().unwrap();
                for (field, def) in &schema.type_def(ty)?.fields {
                    if old.get(id).map(|o| &o[field]) == Some(&object[field]) {
                        continue;
                    }
                    if def.kind == kition_kdm::FieldKind::List {
                        let wanted: Vec<_> = object[field].as_array().into_iter().flatten().filter_map(Value::as_str).map(ObjectId::from_string).collect();
                        let mut current = tx.list_items(&target, field)?;
                        for at in (0..current.len()).rev() {
                            if !wanted.contains(&current[at]) {
                                tx.list_remove(&target, field, at)?;
                                current.remove(at);
                            }
                        }
                        for (at, item) in wanted.iter().enumerate() {
                            if current.get(at) == Some(item) {
                                continue;
                            }
                            if let Some(from) = current.iter().position(|id| id == item) {
                                tx.list_move(&target, field, from, at)?;
                                let item = current.remove(from);
                                current.insert(at, item);
                            } else {
                                tx.list_insert(&target, field, at, item)?;
                                current.insert(at, item.clone());
                            }
                        }
                    } else if old.contains_key(id) {
                        tx.set(&target, field, object[field].clone())?;
                    }
                }
            }
            for id in old.keys().filter(|id| !new.contains_key(*id)) {
                tx.delete(&ObjectId::from_string(id))?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

/// A nested deck's file: its layouts and media (name, content) and its slides.
#[derive(Default)]
struct NestedFile {
    layouts: Vec<(String, String)>,
    media: Vec<(String, String)>,
    slides: Vec<NestedSlide>,
}

/// A slide of a nested deck's file: its number, the name of its layout, and its items.
struct NestedSlide {
    number: u64,
    layout: Option<String>,
    items: Vec<NestedItem>,
}

/// A shape or (`note`) a note: its number, its text, the name of its media, its colour, a table's
/// cells (rows of texts), and the numbers of the shapes a connector joins.
struct NestedItem {
    n: u64,
    note: bool,
    text: String,
    media: Option<String>,
    color: Option<String>,
    table: Option<Vec<Vec<String>>>,
    joins: Option<(u64, u64)>,
}

/// What starts a layout's line in a nested deck's file (`layout Title=big`).
const LAYOUT_LINE: &str = "layout ";
/// What starts a medium's line in a nested deck's file (`media logo=PNG1`).
const MEDIA_LINE: &str = "media ";
/// What names a slide's layout after its number (`1@Title:`).
const LAYOUT_OF: char = '@';
/// What names a picture's media after its text (`2=Caption^logo`).
const MEDIA_OF: char = '^';
/// What separates a table's number from its cells (`3%a,b;c,d`), its cells and its rows.
const TABLE: char = '%';
const CELLS: char = ',';
const ROWS: char = ';';
/// What separates a connector's number from the numbers of the shapes it joins (`6>1,2`).
const JOINS: char = '>';
/// What starts a comment line, which a reader skips (another program's note in the file).
const COMMENT: &str = "//";

fn parse_nested(text: &str) -> Result<NestedFile, String> {
    let mut file = NestedFile::default();
    for line in text.lines().filter(|line| !line.trim().is_empty() && !line.starts_with(COMMENT)) {
        for (start, list) in [(LAYOUT_LINE, &mut file.layouts), (MEDIA_LINE, &mut file.media)] {
            if let Some(rest) = line.strip_prefix(start) {
                let (name, content) = rest.split_once('=').ok_or_else(|| format!("`{line}` is no {}: `{start}<name>=<content>`", start.trim()))?;
                list.push((name.to_owned(), content.to_owned()));
            }
        }
        if line.starts_with(LAYOUT_LINE) || line.starts_with(MEDIA_LINE) {
            continue;
        }
        let (head, rest) = line.split_once(':').ok_or_else(|| format!("`{line}` is no slide: `<number>[@<layout>]:<shapes>`"))?;
        let (number, layout) = match head.split_once(LAYOUT_OF) {
            Some((number, layout)) => (number, Some(layout.to_owned())),
            None => (head, None),
        };
        let number = number.trim().parse::<u64>().map_err(|_| format!("`{number}` is no slide number"))?;
        let mut items = Vec::new();
        for item in rest.split('|').filter(|item| !item.is_empty()) {
            if let Some((n, cells)) = item.split_once(TABLE).filter(|(n, _)| n.trim().parse::<u64>().is_ok()) {
                let (cells, color) = match cells.rsplit_once('#') {
                    Some((cells, color)) => (cells, Some(color.to_owned())),
                    None => (cells, None),
                };
                let rows = cells.split(ROWS).map(|row| row.split(CELLS).map(str::to_owned).collect()).collect();
                let n = n.trim().parse::<u64>().map_err(|_| format!("`{n}` is no shape number"))?;
                items.push(NestedItem { n, note: false, text: String::new(), media: None, color, table: Some(rows), joins: None });
                continue;
            }
            if let Some((n, joined)) = item.split_once(JOINS).filter(|(n, _)| n.trim().parse::<u64>().is_ok()) {
                let (joined, color) = match joined.rsplit_once('#') {
                    Some((joined, color)) => (joined, Some(color.to_owned())),
                    None => (joined, None),
                };
                let ends = joined.split_once(CELLS).and_then(|(a, b)| Some((a.trim().parse::<u64>().ok()?, b.trim().parse::<u64>().ok()?)));
                let joins = ends.ok_or_else(|| format!("`{item}` is no connector: `<number>>{{start}},{{end}}`"))?;
                let n = n.trim().parse::<u64>().map_err(|_| format!("`{n}` is no shape number"))?;
                items.push(NestedItem { n, note: false, text: String::new(), media: None, color, table: None, joins: Some(joins) });
                continue;
            }
            let (n, rest) = item.split_once('=').ok_or_else(|| format!("`{item}` is no shape: `<number>=<text>[^<media>][#colour]`"))?;
            let (n, note) = match n.strip_prefix(NOTE) {
                Some(n) => (n, true),
                None => (n, false),
            };
            let n = n.trim().parse::<u64>().map_err(|_| format!("`{n}` is no shape number"))?;
            let (rest, color) = match rest.rsplit_once('#') {
                Some((rest, color)) => (rest, Some(color.to_owned())),
                None => (rest, None),
            };
            let (text, media) = match rest.rsplit_once(MEDIA_OF) {
                Some((text, media)) if !note => (text.to_owned(), Some(media.to_owned())),
                _ => (rest.to_owned(), None),
            };
            items.push(NestedItem { n, note, text, media, color, table: None, joins: None });
        }
        file.slides.push(NestedSlide { number, layout, items });
    }
    Ok(file)
}

/// A text body holding `text`'s paragraphs (separated by `~`).
fn new_body(tx: &mut kition_kdm::Tx<'_>, text: &str) -> kition_kdm::Result<ObjectId> {
    let body = tx.create("TextBody", Map::new())?;
    for (index, paragraph) in text.split(PARAGRAPHS).enumerate() {
        let para = tx.create("Paragraph", Map::from_iter([("text".to_owned(), json!(paragraph))]))?;
        tx.list_insert(&body, "paragraphs", index, &para)?;
    }
    Ok(body)
}

/// A table holding `rows` of cell texts: rows and columns without tool ids, its cells in an owning
/// map keyed `<row id>:<column id>`, each cell's text in a body it owns.
fn new_table(tx: &mut kition_kdm::Tx<'_>, rows: &[Vec<String>]) -> kition_kdm::Result<ObjectId> {
    let table = tx.create("Table", Map::new())?;
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut cols = Vec::new();
    for at in 0..width {
        let col = tx.create("Col", Map::new())?;
        tx.list_insert(&table, "cols", at, &col)?;
        cols.push(col);
    }
    for (at, cells) in rows.iter().enumerate() {
        let row = tx.create("Row", Map::new())?;
        tx.list_insert(&table, "rows", at, &row)?;
        for (cell, col) in cells.iter().zip(&cols) {
            let body = new_body(tx, cell)?;
            tx.map_set(&table, "cells", &format!("{}:{}", row.as_str(), col.as_str()), json!({ "body": body.as_str() }))?;
        }
    }
    Ok(table)
}

/// A nested deck's replica from its text ([`SCHEMA_NESTED`]). Every object but the root gets a new
/// object id, on every read: only tool ids come from the file.
fn build_nested(text: &str) -> Result<Replica, String> {
    let file = parse_nested(text)?;
    let schema = Arc::new(Schema::parse(SCHEMA_NESTED).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Deck", &ObjectId::from_string(ROOT), Map::new())?;
        let mut shared = std::collections::HashMap::new();
        for (ty, field, list, content) in [("Layout", "layouts", &file.layouts, "look"), ("Media", "media", &file.media, "data")] {
            for (at, (name, value)) in list.iter().enumerate() {
                let object = tx.create(ty, Map::from_iter([("name".to_owned(), json!(name)), (content.to_owned(), json!(value))]))?;
                tx.list_insert(&root, field, at, &object)?;
                shared.insert((ty, name.clone()), object);
            }
        }
        let named = |ty: &'static str, name: &Option<String>| -> kition_kdm::Result<Option<ObjectId>> {
            match name {
                None => Ok(None),
                Some(name) => shared
                    .get(&(ty, name.clone()))
                    .cloned()
                    .map(Some)
                    .ok_or_else(|| kition_kdm::KdmError::NotFound(format!("{} `{name}` (the deck has no such line)", ty.to_lowercase()))),
            }
        };
        for (at, slide_line) in file.slides.iter().enumerate() {
            let slide = tx.create("Slide", Map::from_iter([("number".to_owned(), json!(slide_line.number))]))?;
            tx.list_insert(&root, "slides", at, &slide)?;
            if let Some(layout) = named("Layout", &slide_line.layout)? {
                tx.set(&slide, "layout", json!(layout.as_str()))?;
                tx.set(&slide, "props", json!({ "layouts": { layout.as_str(): { "follow": true } } }))?;
            }
            let (mut shapes, mut notes) = (0, 0);
            let mut numbered: std::collections::HashMap<u64, ObjectId> = std::collections::HashMap::new();
            let mut connectors: Vec<(ObjectId, (u64, u64))> = Vec::new();
            for item in &slide_line.items {
                if item.note {
                    let fields = Map::from_iter([("number".to_owned(), json!(item.n)), ("text".to_owned(), json!(item.text))]);
                    let note = tx.create("Note", fields)?;
                    tx.list_insert(&slide, "notes", notes, &note)?;
                    notes += 1;
                    continue;
                }
                let mut fields = Map::from_iter([("key".to_owned(), json!(format!("{}/{}", slide_line.number, item.n)))]);
                if let Some(color) = &item.color {
                    fields.insert("color".into(), json!(color));
                }
                if let Some(media) = named("Media", &item.media)? {
                    fields.insert("media".into(), json!(media.as_str()));
                    fields.insert("look".into(), json!({ "fill": { "media": media.as_str() } }));
                }
                let shape = tx.create("Shape", fields)?;
                match (&item.table, item.joins) {
                    (Some(rows), _) => {
                        let table = new_table(tx, rows)?;
                        tx.set(&shape, "table", json!(table.as_str()))?;
                    }
                    (None, Some(joins)) => connectors.push((shape.clone(), joins)),
                    (None, None) => {
                        let body = new_body(tx, &item.text)?;
                        tx.set(&shape, "body", json!(body.as_str()))?;
                    }
                }
                numbered.insert(item.n, shape.clone());
                tx.list_insert(&slide, "shapes", shapes, &shape)?;
                shapes += 1;
            }
            for (connector, (start, end)) in connectors {
                let end_of = |n: u64| {
                    numbered
                        .get(&n)
                        .map(|id| id.as_str().to_owned())
                        .ok_or_else(|| kition_kdm::KdmError::NotFound(format!("shape {n} on slide {}", slide_line.number)))
                };
                tx.set(&connector, "look", json!({ "kind": { "start": end_of(start)?, "end": end_of(end)? } }))?;
            }
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

/// What starts a note in a nested deck's file (`!1=Speak slowly`).
const NOTE: &str = "!";

/// The characters a shape's text or colour cannot hold: the file's separators.
const SEPARATORS: [char; 4] = ['|', '#', '\n', '\r'];

/// Refuses a shape's `field` value that holds one of the file's separators (in a nested deck, the
/// paragraph separator `~` too).
pub fn separators(field: &str, value: &str) -> Result<(), String> {
    if *NESTED {
        return match value.chars().find(|c| SEPARATORS.contains(c) || *c == PARAGRAPHS || *c == MEDIA_OF) {
            Some(found) => Err(format!(
                "a shape's {field} cannot hold {found:?}: `|`, `#`, `~`, `^` and line breaks separate shapes, colours, paragraphs, media and slides in the deck's file"
            )),
            None => Ok(()),
        };
    }
    match value.chars().find(|c| SEPARATORS.contains(c)) {
        Some(found) => Err(format!("a shape's {field} cannot hold {found:?}: `|`, `#` and line breaks separate shapes, colours and slides in the deck's file")),
        None => Ok(()),
    }
}

/// What `document.check` reports about the deck: each shape without text is an error, aimed at
/// the shape by its tool id.
pub fn diagnostics(replica: &Replica) -> Vec<Value> {
    let mut found = Vec::new();
    for slide in slides(replica).unwrap_or_default() {
        for shape in shapes(replica, &slide) {
            if shape_text(replica, &shape).is_empty() && (!*NESTED || (table_cells(replica, &shape).is_none() && joined(replica, &shape).is_none())) {
                let id = tool_id(replica, &shape);
                found.push(json!({ "code": "mock.empty-shape", "severity": "error", "target": { "id": id }, "message": format!("{id} has no text.") }));
            }
        }
    }
    found
}

fn root(replica: &Replica) -> Result<ObjectId, String> {
    kition_kdm::batch::root_id(replica).ok_or_else(|| "the deck has no root".to_owned())
}

fn number(replica: &Replica, id: &ObjectId) -> u64 {
    replica.get(id, "number").ok().and_then(|value| value.as_u64()).unwrap_or(0)
}

/// A nested deck's shape's key (`<slideId>/<n>`).
fn key(replica: &Replica, shape: &ObjectId) -> String {
    replica.get(shape, "key").ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The shape's number in the file: deck-wide, or (nested) on its slide.
fn shape_number(replica: &Replica, shape: &ObjectId) -> u64 {
    if *NESTED {
        return key(replica, shape).rsplit_once('/').and_then(|(_, n)| n.parse().ok()).unwrap_or(0);
    }
    number(replica, shape)
}

/// The shape's tool id: `shape:<n>`, or (nested) `shape:<slideId>/<n>`.
fn tool_id(replica: &Replica, shape: &ObjectId) -> String {
    if *NESTED { format!("shape:{}", key(replica, shape)) } else { format!("shape:{}", number(replica, shape)) }
}

/// A nested deck's shape's paragraphs, in order.
fn paragraphs(replica: &Replica, shape: &ObjectId) -> Vec<ObjectId> {
    let body = replica.get(shape, "body").ok().and_then(|value| value.as_str().map(ObjectId::from_string));
    body.map(|body| replica.list(&body, "paragraphs").unwrap_or_default()).unwrap_or_default()
}

fn string(replica: &Replica, id: &ObjectId, field: &str) -> String {
    replica.get(id, field).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The shape's text: its field, or (nested) its paragraphs joined by `~`, as the file holds them.
fn shape_text(replica: &Replica, shape: &ObjectId) -> String {
    if *NESTED {
        let texts: Vec<String> = paragraphs(replica, shape).iter().map(|paragraph| string(replica, paragraph, "text")).collect();
        return texts.join(&PARAGRAPHS.to_string());
    }
    string(replica, shape, "text")
}

/// The numbers of the shapes a nested deck's connector joins (its `look.kind.start` and `end`, by
/// object id); `None` for a shape that is no connector.
fn joined(replica: &Replica, shape: &ObjectId) -> Option<(u64, u64)> {
    let look = replica.get(shape, "look").ok()?;
    let end = |side: &str| look["kind"][side].as_str().map(|id| shape_number(replica, &ObjectId::from_string(id)));
    Some((end("start")?, end("end")?))
}

/// A nested deck's table shape's cells' texts, by row and column; `None` for a shape that holds no
/// table.
fn table_cells(replica: &Replica, shape: &ObjectId) -> Option<Vec<Vec<String>>> {
    let table = referenced(replica, shape, "table")?;
    let cols = replica.list(&table, "cols").unwrap_or_default();
    let cells: std::collections::HashMap<String, Value> = replica.map_entries(&table, "cells").unwrap_or_default().into_iter().collect();
    let text = |body: &ObjectId| {
        let texts: Vec<String> = replica.list(body, "paragraphs").unwrap_or_default().iter().map(|paragraph| string(replica, paragraph, "text")).collect();
        texts.join(&PARAGRAPHS.to_string())
    };
    let rows = replica.list(&table, "rows").unwrap_or_default();
    Some(
        rows.iter()
            .map(|row| {
                cols.iter()
                    .map(|col| {
                        let body = cells.get(&format!("{}:{}", row.as_str(), col.as_str())).and_then(|cell| cell["body"].as_str()).map(ObjectId::from_string);
                        body.map(|body| text(&body)).unwrap_or_default()
                    })
                    .collect()
            })
            .collect(),
    )
}

/// The deck's slides, in order.
fn slides(replica: &Replica) -> Result<Vec<ObjectId>, String> {
    replica.list(&root(replica)?, "slides").map_err(|error| error.to_string())
}

fn shapes(replica: &Replica, slide: &ObjectId) -> Vec<ObjectId> {
    replica.list(slide, "shapes").unwrap_or_default()
}

/// The deck as the file holds it.
pub fn text_of(replica: &Replica) -> String {
    if *NESTED {
        return nested_text_of(replica);
    }
    let mut lines = Vec::new();
    for slide in slides(replica).unwrap_or_default() {
        let items = shapes(replica, &slide)
            .iter()
            .map(|shape| {
                let text = shape_text(replica, shape);
                let n = shape_number(replica, shape);
                match replica.get(shape, "color").ok().and_then(|value| value.as_str().map(str::to_owned)) {
                    Some(color) => format!("{n}={text}#{color}"),
                    None => format!("{n}={text}"),
                }
            })
            .collect::<Vec<_>>();
        lines.push(format!("{}:{}", number(replica, &slide), items.join("|")));
    }
    lines.join("\n")
}

/// The id a ref field of `id` holds.
fn referenced(replica: &Replica, id: &ObjectId, field: &str) -> Option<ObjectId> {
    replica.get(id, field).ok().and_then(|value| value.as_str().map(ObjectId::from_string))
}

/// A nested deck as its file holds it: its layouts, its media, then its slides.
fn nested_text_of(replica: &Replica) -> String {
    let mut lines = Vec::new();
    let root = root(replica).ok();
    for (start, field, content) in [(LAYOUT_LINE, "layouts", "look"), (MEDIA_LINE, "media", "data")] {
        for object in root.as_ref().and_then(|root| replica.list(root, field).ok()).unwrap_or_default() {
            lines.push(format!("{start}{}={}", string(replica, &object, "name"), string(replica, &object, content)));
        }
    }
    for slide in slides(replica).unwrap_or_default() {
        let mut items: Vec<String> = shapes(replica, &slide)
            .iter()
            .map(|shape| {
                if let Some((start, end)) = joined(replica, shape) {
                    let mut item = format!("{}{JOINS}{start}{CELLS}{end}", shape_number(replica, shape));
                    if let Some(color) = replica.get(shape, "color").ok().and_then(|value| value.as_str().map(str::to_owned)) {
                        item.push_str(&format!("#{color}"));
                    }
                    return item;
                }
                if let Some(rows) = table_cells(replica, shape) {
                    let rows: Vec<String> = rows.iter().map(|cells| cells.join(&CELLS.to_string())).collect();
                    let mut item = format!("{}{TABLE}{}", shape_number(replica, shape), rows.join(&ROWS.to_string()));
                    if let Some(color) = replica.get(shape, "color").ok().and_then(|value| value.as_str().map(str::to_owned)) {
                        item.push_str(&format!("#{color}"));
                    }
                    return item;
                }
                let mut item = format!("{}={}", shape_number(replica, shape), shape_text(replica, shape));
                if let Some(media) = referenced(replica, shape, "media") {
                    item.push_str(&format!("{MEDIA_OF}{}", string(replica, &media, "name")));
                }
                if let Some(color) = replica.get(shape, "color").ok().and_then(|value| value.as_str().map(str::to_owned)) {
                    item.push_str(&format!("#{color}"));
                }
                item
            })
            .collect();
        for note in replica.list(&slide, "notes").unwrap_or_default() {
            items.push(format!("{NOTE}{}={}", number(replica, &note), string(replica, &note, "text")));
        }
        let layout = referenced(replica, &slide, "layout").map(|layout| format!("{LAYOUT_OF}{}", string(replica, &layout, "name"))).unwrap_or_default();
        lines.push(format!("{}{layout}:{}", number(replica, &slide), items.join("|")));
    }
    lines.join("\n")
}

/// How many slides the deck has.
pub fn count(replica: &Replica) -> usize {
    slides(replica).map_or(0, |slides| slides.len())
}

/// The index of the slide numbered `id`.
pub fn slide_index(replica: &Replica, id: u64) -> Option<usize> {
    slides(replica).ok()?.iter().position(|slide| number(replica, slide) == id)
}

/// The shape a tool id (`shape:3`, nested `shape:1/3`) names, and the slide holding it.
fn shape(replica: &Replica, id: &str) -> Result<(ObjectId, ObjectId, usize), String> {
    let wanted = id.strip_prefix("shape:").filter(|rest| !rest.is_empty());
    let form = if *NESTED { "`shape:<slideId>/<number>`" } else { "`shape:<number>`" };
    let wanted = wanted.filter(|rest| *NESTED || rest.parse::<u64>().is_ok()).ok_or_else(|| format!("`{id}` is no shape id ({form})"))?;
    for slide in slides(replica)? {
        if let Some(index) = shapes(replica, &slide).iter().position(|shape| tool_id(replica, shape).strip_prefix("shape:") == Some(wanted)) {
            let shape = shapes(replica, &slide).swap_remove(index);
            return Ok((shape, slide, index));
        }
    }
    Err(format!("no shape `{id}` in the deck"))
}

/// Whether the deck has the shape `id` (a tool id).
pub fn has_shape(replica: &Replica, id: &str) -> bool {
    shape(replica, id).is_ok()
}

/// `slide.inspect` of the slide at `index`: its number (`id`), and its shapes by tool id (a nested
/// deck's text with its paragraphs joined by line breaks).
pub fn inspect(replica: &Replica, index: usize) -> Result<Value, String> {
    let slides = slides(replica)?;
    let slide = slides.get(index).ok_or_else(|| format!("slide index {index} is past the last slide (the deck has {}, counted from 0)", slides.len()))?;
    let listed: Vec<Value> = shapes(replica, slide)
        .iter()
        .map(|shape| {
            let text =
                if *NESTED { Value::String(shape_text(replica, shape).replace(PARAGRAPHS, "\n")) } else { replica.get(shape, "text").unwrap_or(Value::Null) };
            let mut listed = json!({ "id": tool_id(replica, shape), "text": text });
            if let Some(rows) = (*NESTED).then(|| table_cells(replica, shape)).flatten() {
                listed["text"] = Value::Null;
                listed["cells"] = json!(rows);
            }
            if let Ok(color) = replica.get(shape, "color")
                && !color.is_null()
            {
                listed["color"] = color;
            }
            listed
        })
        .collect();
    Ok(json!({ "id": number(replica, slide), "index": index, "shapes": listed }))
}

/// The highest number of the objects of `ty`.
fn highest(replica: &Replica, ty: &str) -> u64 {
    replica.objects_of_type(ty).iter().map(|id| number(replica, id)).max().unwrap_or(0)
}

/// A nested deck's next shape number on `slide`.
fn next_shape(replica: &Replica, slide: &ObjectId) -> u64 {
    shapes(replica, slide).iter().map(|shape| shape_number(replica, shape)).max().unwrap_or(0) + 1
}

/// Numbers what a batch created in a nested deck, as the kit does: a slide one more than the
/// highest, a shape one more than the highest on its slide (`key` `<slideId>/<n>`), a note one
/// more than the highest on its slide.
pub fn number_nested(replica: &mut Replica) -> Result<(), String> {
    let mut slide_numbers = Vec::new();
    let mut next = highest(replica, "Slide");
    for slide in slides(replica)? {
        if replica.get(&slide, "number").ok().is_none_or(|value| value.is_null()) {
            next += 1;
            slide_numbers.push((slide, next));
        }
    }
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    if !slide_numbers.is_empty() {
        replica.transact(&Origin::system("number"), |tx| slide_numbers.iter().try_for_each(|(slide, n)| tx.set(slide, "number", json!(n)))).map_err(kdm)?;
    }
    let mut keys = Vec::new();
    let mut notes = Vec::new();
    for slide in slides(replica)? {
        let id = number(replica, &slide);
        let mut n = next_shape(replica, &slide);
        for shape in shapes(replica, &slide) {
            if key(replica, &shape).is_empty() {
                keys.push((shape, format!("{id}/{n}")));
                n += 1;
            }
        }
        let held = replica.list(&slide, "notes").unwrap_or_default();
        let mut n = held.iter().map(|note| number(replica, note)).max().unwrap_or(0) + 1;
        for note in held {
            if replica.get(&note, "number").ok().is_none_or(|value| value.is_null()) {
                notes.push((note, n));
                n += 1;
            }
        }
    }
    if keys.is_empty() && notes.is_empty() {
        return Ok(());
    }
    replica
        .transact(&Origin::system("number"), |tx| {
            for (shape, key) in &keys {
                tx.set(shape, "key", json!(key))?;
            }
            for (note, n) in &notes {
                tx.set(note, "number", json!(n))?;
            }
            Ok(())
        })
        .map_err(kdm)
}

/// Runs one of the deck's editing commands as `origin`; answers its result. `scope` is
/// `edit.undo`'s undo scope.
pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Option<Value>, String> {
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("`{key}` is a string"));
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    match command {
        "shape.text" if *NESTED => {
            // The shape's whole text: its first paragraph holds it, the others go.
            let (shape, _, _) = shape(replica, &text("id")?)?;
            let value = text("text")?;
            separators("text", &value)?;
            if table_cells(replica, &shape).is_some() {
                return Err("the shape is a table: its text is in its cells".to_owned());
            }
            let held = paragraphs(replica, &shape);
            let body = replica.get(&shape, "body").ok().and_then(|value| value.as_str().map(ObjectId::from_string));
            replica
                .transact(origin, |tx| {
                    let body = match &body {
                        Some(body) => body.clone(),
                        None => {
                            let body = tx.create("TextBody", Map::new())?;
                            tx.set(&shape, "body", json!(body.as_str()))?;
                            body
                        }
                    };
                    match held.first() {
                        Some(first) => tx.set(first, "text", json!(value))?,
                        None => {
                            let paragraph = tx.create("Paragraph", Map::from_iter([("text".to_owned(), json!(value))]))?;
                            tx.list_insert(&body, "paragraphs", 0, &paragraph)?;
                        }
                    }
                    for (at, paragraph) in held.iter().enumerate().skip(1).rev() {
                        tx.list_remove(&body, "paragraphs", at)?;
                        tx.delete(paragraph)?;
                    }
                    Ok(())
                })
                .map_err(kdm)?;
            Ok(None)
        }
        "shape.paragraph" if *NESTED => {
            let (shape, _, _) = shape(replica, &text("id")?)?;
            let value = text("text")?;
            separators("text", &value)?;
            let body = replica.get(&shape, "body").ok().and_then(|value| value.as_str().map(ObjectId::from_string)).ok_or("the shape has no text body")?;
            let at = paragraphs(replica, &shape).len();
            replica
                .transact(origin, |tx| {
                    let paragraph = tx.create("Paragraph", Map::from_iter([("text".to_owned(), json!(value))]))?;
                    tx.list_insert(&body, "paragraphs", at, &paragraph)
                })
                .map_err(kdm)?;
            Ok(None)
        }
        "shape.text" | "shape.color" => {
            let (shape, _, _) = shape(replica, &text("id")?)?;
            let (field, value) = if command == "shape.text" { ("text", text("text")?) } else { ("color", text("color")?) };
            separators(field, &value)?;
            replica.transact(origin, |tx| tx.set(&shape, field, json!(value))).map_err(kdm)?;
            Ok(None)
        }
        "shape.delete" => {
            let (shape, slide, index) = shape(replica, &text("id")?)?;
            let body = if *NESTED { replica.get(&shape, "body").ok().and_then(|value| value.as_str().map(ObjectId::from_string)) } else { None };
            let held = if *NESTED { paragraphs(replica, &shape) } else { Vec::new() };
            replica
                .transact(origin, |tx| {
                    tx.list_remove(&slide, "shapes", index)?;
                    tx.delete(&shape)?;
                    if let Some(body) = &body {
                        tx.delete(body)?;
                    }
                    held.iter().try_for_each(|paragraph| tx.delete(paragraph))
                })
                .map_err(kdm)?;
            Ok(None)
        }
        "shapes.delete" if *NESTED => {
            // Its declared targets are `ids`; one shape may be given as `id` too, as a real slide
            // kit's `drawing.delete` takes it.
            let mut given: Vec<String> =
                params.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            given.extend(params.get("id").and_then(Value::as_str).map(str::to_owned));
            if given.is_empty() {
                return Err("`ids` (or `id`) names the shapes to delete".to_owned());
            }
            for id in given {
                edit(replica, "shape.delete", &Map::from_iter([("id".to_owned(), json!(id))]), origin)?;
            }
            Ok(None)
        }
        "shape.connect" if *NESTED => {
            // A connector (`id`) joins the shapes `from` and `to`: its `look` names them by their
            // object ids, as a real slide kit's connectors do.
            let (connector, _, _) = shape(replica, &text("id")?)?;
            let (from, _, _) = shape(replica, &text("from")?)?;
            let (to, _, _) = shape(replica, &text("to")?)?;
            let look = json!({ "kind": { "start": from.as_str(), "end": to.as_str() } });
            replica.transact(origin, |tx| tx.set(&connector, "look", look)).map_err(kdm)?;
            Ok(None)
        }
        "shape.move" => {
            let (shape, from, index) = shape(replica, &text("id")?)?;
            let to = params.get("slideId").and_then(Value::as_u64).ok_or("`slideId` is the number of the slide to move it to")?;
            let to_number = to;
            let to = slide_index(replica, to).and_then(|at| slides(replica).ok()?.get(at).cloned()).ok_or_else(|| format!("no slide has id {to}"))?;
            let end = shapes(replica, &to).len() - usize::from(to == from);
            // A nested deck's shape is numbered on its slide: on another, it is given a new number.
            let key = (*NESTED && to != from).then(|| format!("{to_number}/{}", next_shape(replica, &to)));
            replica
                .transact(origin, |tx| {
                    tx.list_remove(&from, "shapes", index)?;
                    tx.list_insert(&to, "shapes", end, &shape)?;
                    if let Some(key) = &key {
                        tx.set(&shape, "key", json!(key))?;
                    }
                    Ok(())
                })
                .map_err(kdm)?;
            Ok(None)
        }
        "slide.insert" => {
            let at = params.get("index").and_then(Value::as_u64).ok_or("`index` is where the new slide goes, counted from 0")? as usize;
            if at > count(replica) {
                return Err(format!("index {at} is past the end of the deck ({} slides)", count(replica)));
            }
            let root = root(replica)?;
            let next = highest(replica, "Slide") + 1;
            replica
                .transact(origin, |tx| {
                    let slide = tx.create("Slide", Map::from_iter([("number".to_owned(), json!(next))]))?;
                    tx.list_insert(&root, "slides", at, &slide)
                })
                .map_err(kdm)?;
            Ok(Some(json!({ "id": next })))
        }
        "edit.undo" | "edit.redo" => {
            let scope = match params.get("scope").and_then(Value::as_str) {
                Some(scope) => UndoScope::parse(scope).ok_or("`scope` is person or agent")?,
                None => UndoScope::of(origin.kind).unwrap_or(UndoScope::Person),
            };
            let done = if command == "edit.undo" { replica.undo_in(scope) } else { replica.redo_in(scope) }.map_err(kdm)?.is_done();
            if !done {
                return Err(format!("nothing to {}", if command == "edit.undo" { "undo" } else { "redo" }));
            }
            Ok(None)
        }
        other => Err(format!("unknown command `{other}`")),
    }
}

/// The commands a deck offers, beside `slide.go` and `slide.inspect`: what each takes, and the
/// parameter that names the object it acts on (`x-khp-role: targets`). A nested deck also appends
/// a paragraph to a shape (`shape.paragraph`).
pub fn commands() -> Vec<(&'static str, &'static str, Value)> {
    let on_shape = |extra: Value| {
        let mut properties = json!({ "id": { "type": "string", "x-khp-role": "targets" } });
        let mut required = vec![json!("id")];
        for (key, schema) in extra.as_object().into_iter().flatten() {
            properties[key] = schema.clone();
            required.push(json!(key));
        }
        json!({ "type": "object", "additionalProperties": false, "required": required, "properties": properties })
    };
    let mut commands = vec![
        ("shape.text", "Sets the text of a shape by its `id` (`shape:<number>`).", on_shape(json!({ "text": { "type": "string" } }))),
        ("shape.color", "Sets the colour of a shape by its `id`.", on_shape(json!({ "color": { "type": "string" } }))),
        ("shape.delete", "Deletes a shape by its `id`.", on_shape(json!({}))),
        ("shape.move", "Moves a shape to the end of the slide `slideId`.", on_shape(json!({ "slideId": { "type": "integer" } }))),
        (
            "slide.insert",
            "Inserts an empty slide at `index` (counted from 0); answers its `id`.",
            json!({ "type": "object", "additionalProperties": false, "required": ["index"], "properties": { "index": { "type": "integer", "minimum": 0, "x-khp-role": "place" } } }),
        ),
    ];
    if *NESTED {
        commands.push(("shape.paragraph", "Appends a paragraph with `text` to a shape by its `id`.", on_shape(json!({ "text": { "type": "string" } }))));
        // Targets declared as `ids`, one shape taken as `id` too; and ids in parameters that are
        // no targets (`from`, `to`).
        commands.push((
            "shapes.delete",
            "Deletes the shapes `ids` (or the one shape `id`).",
            json!({ "type": "object", "additionalProperties": false, "properties": {
                "ids": { "type": "array", "items": { "type": "string" }, "x-khp-role": "targets" },
                "id": { "type": "string", "x-khp-role":"object" }
            } }),
        ));
        commands.push((
            "shape.connect",
            "Makes the connector `id` join the shapes `from` and `to`.",
            on_shape(json!({ "from": { "type": "string", "x-khp-role":"object" }, "to": { "type": "string", "x-khp-role":"object" } })),
        ));
    }
    commands
}
