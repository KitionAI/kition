// Copied from kition-sdk crates/kition-kdm/tests/reread.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::expect_used)]
//! Two reads of a file compared across new object ids: objects are
//! paired by tool id, by their place under paired holders, and by content, never by object id, so
//! a file read again with every object id minted anew tells only what changed in it.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use kition_kdm::Schema;
use kition_kdm::reread::{diff_read_again, pair};
use serde_json::{Map, Value, json};

#[test]
fn inline_objects_held_only_by_marks_compare_by_paired_identity() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.inline","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"paragraphs":{"kind":"list","of":"Paragraph"}}},
            "Paragraph":{"fields":{"text":{"kind":"text","marks":{"object":{"expand":"none"},"bold":{"expand":"after"}}}}},
            "Inline":{"fields":{"key":{"kind":"string","readOnly":true},"rotation":{"kind":"number"}},"toolId":{"field":"key","prefix":"inline:"}}
        }})
        .to_string(),
    )
    .unwrap();
    let read = |mint: &str, rotation: u32| {
        let (root, paragraph, inline) = (format!("{mint}-root"), format!("{mint}-paragraph"), format!("{mint}-inline"));
        json!({"objects":{
            root:{"$type":"Root","paragraphs":[paragraph]},
            paragraph:{"$type":"Paragraph","text":[{"insert":"drawing","attributes":{"object":inline,"bold":true}}]},
            inline:{"$type":"Inline","key":"1","rotation":rotation}
        }})
    };
    let before = read("a", 0);
    let same = read("b", 0);
    assert!(kition_kdm::reread::diff_paired(&schema, &before, &same).is_empty());
    let changed = kition_kdm::reread::diff_paired(&schema, &before, &read("b", 45)).to_json();
    assert_eq!(changed["changed"].as_array().unwrap().len(), 1, "{changed}");
    assert_eq!(changed["changed"][0]["id"], "inline:1", "{changed}");
    assert_eq!(changed["changed"][0]["fields"], json!(["rotation"]));
}

#[test]
fn deletion_keeps_old_position_without_tool_ids() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"items":{"kind":"list","of":"Item"}}},"Item":{"fields":{"name":{"kind":"string"}}}
        }})
        .to_string(),
    )
    .unwrap();
    let mut before = json!({"objects":{"root":{"$type":"Root","items":["a","b","c"]},"a":{"$type":"Item","name":"A"},"b":{"$type":"Item","name":"B"},"c":{"$type":"Item","name":"C"}}});
    let mut after = json!({"objects":{"root":{"$type":"Root","items":["b","c"]},"b":{"$type":"Item","name":"B"},"c":{"$type":"Item","name":"C"}}});
    for i in 0..8 {
        before["objects"][format!("old-{i}")] = json!({"$type":"Detail"});
        after["objects"][format!("new-{i}")] = json!({"$type":"Detail"});
    }
    let diff = diff_read_again(&schema, &before, &after);
    assert_eq!(diff.to_json()["deleted"][0]["id"], "a");
    let recorded = diff.to_recorded_json(&schema);
    assert_eq!(recorded["deleted"][0]["at"], json!({"parent":"root","field":"items","index":0}), "{recorded}");
}

/// A deck as a slide kit models it: slides and shapes with tool ids, a shape's text in an owned
/// body of paragraphs, a table whose cells (keyed `<row>:<col>` by object ids) own their bodies,
/// layouts and media the deck holds, which slides and pictures point at.
fn schema() -> Schema {
    Schema::parse(
        &json!({
            "kdm": 1, "kit": "kit.reread", "schemaVersion": 1, "root": "Deck",
            "types": {
                "Deck": { "fields": {
                    "slides": { "kind": "list", "of": "Slide" },
                    "layouts": { "kind": "list", "of": "Layout" },
                    "media": { "kind": "list", "of": "Media" }
                } },
                "Layout": { "fields": { "name": { "kind": "string" } } },
                "Media": { "fields": { "data": { "kind": "string" } } },
                "Slide": { "fields": {
                    "number": { "kind": "integer", "optional": true, "readOnly": true },
                    "layout": { "kind": "ref", "of": "Layout", "optional": true },
                    "props": { "kind": "json", "optional": true },
                    "shapes": { "kind": "list", "of": "Shape" }
                }, "toolId": { "field": "number", "prefix": "slide:" } },
                "Shape": { "fields": {
                    "key": { "kind": "string", "optional": true, "readOnly": true },
                    "body": { "kind": "ref", "of": "TextBody", "optional": true, "owns": true },
                    "table": { "kind": "ref", "of": "Table", "optional": true, "owns": true },
                    "media": { "kind": "ref", "of": "Media", "optional": true },
                    "look": { "kind": "json", "optional": true }
                }, "toolId": { "field": "key", "prefix": "shape:" } },
                "Table": { "fields": { "rows": { "kind": "list", "of": "Row" }, "cells": { "kind": "map", "owns": true } } },
                "Row": { "fields": { "height": { "kind": "number", "optional": true } } },
                "TextBody": { "fields": { "paragraphs": { "kind": "list", "of": "Paragraph" } } },
                "Paragraph": { "fields": { "text": { "kind": "string" } } }
            }
        })
        .to_string(),
    )
    .unwrap()
}

/// Builds states from a deck description, minting object ids with `mint` (a read's own ids).
struct Builder {
    mint: &'static str,
    next: usize,
    objects: Map<String, Value>,
    /// The root's id when the kit keeps it on every read; else minted.
    root: Option<String>,
}

impl Builder {
    fn new(mint: &'static str) -> Self {
        Self { mint, next: 0, objects: Map::new(), root: None }
    }

    fn add(&mut self, id: Option<String>, ty: &str, mut fields: Value) -> String {
        let id = id.unwrap_or_else(|| {
            self.next += 1;
            format!("{}-{:04}", self.mint, self.next)
        });
        fields["$type"] = json!(ty);
        self.objects.insert(id.clone(), fields);
        id
    }

    fn body(&mut self, texts: &[&str]) -> String {
        let paragraphs: Vec<String> = texts.iter().map(|text| self.add(None, "Paragraph", json!({ "text": text }))).collect();
        self.add(None, "TextBody", json!({ "paragraphs": paragraphs }))
    }

    /// `slides`: each slide's number, layout index, and shapes (number, paragraphs, media index).
    #[allow(clippy::type_complexity)]
    fn deck(mut self, layouts: &[&str], media: &[&str], slides: &[(u64, usize, Vec<(u64, Vec<&str>, Option<usize>)>)], cells: &[&str]) -> Value {
        let layouts: Vec<String> = layouts.iter().map(|name| self.add(None, "Layout", json!({ "name": name }))).collect();
        let media: Vec<String> = media.iter().map(|data| self.add(None, "Media", json!({ "data": data }))).collect();
        let mut listed = Vec::new();
        for (number, layout, shapes) in slides {
            let mut held = Vec::new();
            for (n, texts, picture) in shapes {
                let body = self.body(texts);
                let mut fields = json!({ "key": format!("{number}/{n}"), "body": body });
                if let Some(at) = picture {
                    fields["media"] = json!(media[*at]);
                    fields["look"] = json!({ "kind": { "fill": { "media": media[*at] } } });
                }
                held.push(self.add(Some(format!("shape:{number}/{n}")), "Shape", fields));
            }
            if *number == 1 && !cells.is_empty() {
                let rows: Vec<String> = (0..cells.len()).map(|_| self.add(None, "Row", json!({}))).collect();
                let mut map = Map::new();
                for (row, text) in rows.iter().zip(cells) {
                    let body = self.body(&[text]);
                    map.insert(format!("{row}:c1"), json!({ "body": body, "fill": "red" }));
                }
                let table = self.add(None, "Table", json!({ "rows": rows, "cells": map }));
                held.push(self.add(Some(format!("shape:{number}/9")), "Shape", json!({ "key": format!("{number}/9"), "table": table })));
            }
            let props = json!({ "layouts": { layouts[*layout].clone(): { "follow": true } }, "pair": { format!("{}:{}", layouts[0], layouts[1]): 1 } });
            listed.push(self.add(
                Some(format!("slide:{number}")),
                "Slide",
                json!({ "number": number, "layout": layouts[*layout], "props": props, "shapes": held }),
            ));
        }
        self.add(self.root.clone(), "Deck", json!({ "slides": listed, "layouts": layouts, "media": media }));
        json!({ "objects": self.objects })
    }
}

#[allow(clippy::type_complexity)]
fn talk(
    mint: &'static str,
    edit: impl FnOnce(&mut Vec<(u64, usize, Vec<(u64, Vec<&'static str>, Option<usize>)>)>, &mut Vec<&'static str>, &mut Vec<&'static str>),
) -> Value {
    let mut slides: Vec<(u64, usize, Vec<(u64, Vec<&'static str>, Option<usize>)>)> =
        (1..=4).map(|n| (n, (n % 2) as usize, vec![(1, vec!["Title"], None), (2, vec!["One", "Two", "Three"], if n == 4 { Some(0) } else { None })])).collect();
    let mut media = vec!["PNG1", "PNG2"];
    let mut cells = vec!["A", "B"];
    edit(&mut slides, &mut media, &mut cells);
    Builder::new(mint).deck(&["Title", "Plain"], &media, &slides, &cells)
}

#[test]
fn a_file_read_again_unchanged_tells_nothing() {
    let schema = schema();
    let (before, after) = (talk("a", |_, _, _| {}), talk("b", |_, _, _| {}));
    let diff = diff_read_again(&schema, &before, &after);
    assert!(diff.is_empty() && diff.unnamed.is_empty(), "{}", diff.to_json());
    assert_eq!(pair(&schema, &before, &after).len(), before["objects"].as_object().unwrap().len(), "every object paired");
}

#[test]
fn a_text_edit_is_told_by_its_shape_at_its_path() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    let after = talk("b", |slides, _, _| slides[2].2[1].1[1] = "Deux");
    assert_eq!(
        diff_read_again(&schema, &before, &after).to_json(),
        json!({ "created": [], "moved": [], "deleted": [], "changed": [{ "id": "shape:3/2", "type": "Shape", "fields": ["body.paragraphs.1.text"], "edits": [{ "field": "body.paragraphs.1.text", "before": "Two", "after": "Deux" }] }] })
    );
}

#[test]
fn a_paragraph_inserted_leaves_the_later_ones_unchanged() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    let after = talk("b", |slides, _, _| slides[0].2[1].1.insert(0, "Zero"));
    let diff = diff_read_again(&schema, &before, &after).to_json();
    assert_eq!(diff["changed"].as_array().unwrap().len(), 1, "{diff}");
    assert_eq!(diff["changed"][0]["id"], "shape:1/2", "{diff}");
    assert_eq!(diff["changed"][0]["edits"], json!([{ "field": "body.paragraphs.0", "before": null, "after": { "text": "Zero" } }]), "{diff}");
}

#[test]
fn a_slide_inserted_is_created_and_the_others_are_kept() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    let after = talk("b", |slides, _, _| slides.insert(0, (9, 0, vec![(1, vec!["New"], None)])));
    let diff = diff_read_again(&schema, &before, &after);
    let json = diff.to_json();
    let created: Vec<&str> = json["created"].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap()).collect();
    assert_eq!(created, ["shape:9/1", "slide:9"], "{json}");
    assert_eq!(json["created"][1]["at"]["index"], 0, "{json}");
    assert!(json["changed"].as_array().unwrap().is_empty() && json["moved"].as_array().unwrap().is_empty(), "{json}");
    assert_eq!(json["unnamed"], json!({ "Deck": { "changed": 1 } }), "the root's list changed: counted, not named");
}

#[test]
fn shared_media_changed_is_counted_and_what_points_at_it_did_not_change() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    let after = talk("b", |_, media, _| media[0] = "PNG9");
    assert_eq!(
        diff_read_again(&schema, &before, &after).to_json(),
        json!({ "created": [], "changed": [], "moved": [], "deleted": [], "unnamed": { "Media": { "changed": 1 } } })
    );
}

#[test]
fn table_cells_keyed_by_object_ids_pair_through_their_rows() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    let after = talk("b", |_, _, cells| cells[1] = "Bee");
    let diff = diff_read_again(&schema, &before, &after).to_json();
    let changed = &diff["changed"];
    assert_eq!(changed.as_array().unwrap().len(), 1, "{diff}");
    assert_eq!(changed[0]["id"], "shape:1/9", "{diff}");
    let field = changed[0]["edits"][0]["field"].as_str().unwrap();
    assert!(field.starts_with("table.cells.b-") && field.ends_with(":c1.body.paragraphs.0.text"), "{diff}");
    assert_eq!((changed[0]["edits"][0]["before"].clone(), changed[0]["edits"][0]["after"].clone()), (json!("B"), json!("Bee")), "{diff}");
}

#[test]
fn a_kit_that_keeps_object_ids_is_compared_by_them() {
    let schema = schema();
    let before = talk("a", |_, _, _| {});
    // The same ids, one paragraph replaced by a new object: another object, not the same changed.
    let mut after = before.clone();
    let paragraphs = after["objects"].as_object().unwrap().iter().find(|(_, object)| object["$type"] == "TextBody").map(|(id, _)| id.clone()).unwrap();
    let first = after["objects"][&paragraphs]["paragraphs"][0].as_str().unwrap().to_owned();
    after["objects"].as_object_mut().unwrap().remove(&first);
    after["objects"]["new-paragraph"] = json!({ "$type": "Paragraph", "text": "Title" });
    after["objects"][&paragraphs]["paragraphs"][0] = json!("new-paragraph");
    let pairing = pair(&schema, &before, &after);
    assert!(!pairing.reminted);
    assert_eq!(pairing.after(&first), None, "a deleted object is not paired with a new one");
    assert!(diff_read_again(&schema, &before, &after).unnamed.is_empty());
}

// ---- what a real slide kit showed ----

/// [`talk`], the deck's root keeping the id `slide-file` on every read, as a real slide kit's does.
#[allow(clippy::type_complexity)]
fn talk_rooted(
    mint: &'static str,
    edit: impl FnOnce(&mut Vec<(u64, usize, Vec<(u64, Vec<&'static str>, Option<usize>)>)>, &mut Vec<&'static str>, &mut Vec<&'static str>),
) -> Value {
    let mut slides: Vec<(u64, usize, Vec<(u64, Vec<&'static str>, Option<usize>)>)> =
        (1..=4).map(|n| (n, (n % 2) as usize, vec![(1, vec!["Title"], None), (2, vec!["One", "Two", "Three"], if n == 4 { Some(0) } else { None })])).collect();
    let mut media = vec!["PNG1", "PNG2"];
    let mut cells = vec!["A", "B"];
    edit(&mut slides, &mut media, &mut cells);
    let mut builder = Builder::new(mint);
    builder.root = Some("slide-file".to_owned());
    builder.deck(&["Title", "Plain"], &media, &slides, &cells)
}

#[test]
fn a_constant_root_id_pairs_the_root_and_every_other_object_still_pairs() {
    let schema = schema();
    let (before, after) = (talk_rooted("a", |_, _, _| {}), talk_rooted("b", |_, _, _| {}));
    let pairing = pair(&schema, &before, &after);
    assert_eq!(pairing.len(), before["objects"].as_object().unwrap().len(), "every object paired");
    assert!(pairing.reminted, "a constant root is no sign the kit keeps object ids");
    let diff = diff_read_again(&schema, &before, &after);
    assert!(diff.is_empty() && diff.unnamed.is_empty(), "{}", diff.to_json());

    let after = talk_rooted("b", |slides, _, _| slides[2].2[1].1[1] = "Deux");
    assert_eq!(
        diff_read_again(&schema, &before, &after).to_json(),
        json!({ "created": [], "moved": [], "deleted": [], "changed": [{ "id": "shape:3/2", "type": "Shape", "fields": ["body.paragraphs.1.text"], "edits": [{ "field": "body.paragraphs.1.text", "before": "Two", "after": "Deux" }] }] })
    );
}

#[test]
fn ids_inside_json_values_and_keys_are_read_through_the_pairing() {
    let schema = schema();
    let before = talk_rooted("a", |_, _, _| {});
    // The media a picture's `look` names inside json changed: counted, the picture unchanged.
    let after = talk_rooted("b", |_, media, _| media[0] = "PNG9");
    assert_eq!(
        diff_read_again(&schema, &before, &after).to_json(),
        json!({ "created": [], "changed": [], "moved": [], "deleted": [], "unnamed": { "Media": { "changed": 1 } } })
    );
    // A text a person typed that equals an object id of the read before is text, not an id.
    let layout = before["objects"].as_object().unwrap().iter().find(|(_, object)| object["$type"] == "Layout").map(|(id, _)| id.clone()).unwrap();
    let with_text = |mut state: Value| {
        let paragraph = state["objects"].as_object().unwrap().iter().find(|(_, object)| object["$type"] == "Paragraph").map(|(id, _)| id.clone()).unwrap();
        state["objects"][&paragraph]["text"] = json!(layout.clone());
        state
    };
    let (before, after) = (with_text(before), with_text(talk_rooted("b", |_, _, _| {})));
    let diff = diff_read_again(&schema, &before, &after);
    assert!(diff.is_empty() && diff.unnamed.is_empty(), "{}", diff.to_json());
}

#[test]
fn table_cells_keyed_by_object_ids_tell_one_cell_under_a_constant_root() {
    let schema = schema();
    let before = talk_rooted("a", |_, _, _| {});
    let after = talk_rooted("b", |_, _, cells| cells[1] = "Bee");
    let diff = diff_read_again(&schema, &before, &after).to_json();
    assert_eq!(diff["changed"].as_array().unwrap().len(), 1, "{diff}");
    assert_eq!(diff["changed"][0]["fields"].as_array().unwrap().len(), 1, "one cell: {diff}");
    assert_eq!((diff["changed"][0]["edits"][0]["before"].clone(), diff["changed"][0]["edits"][0]["after"].clone()), (json!("B"), json!("Bee")), "{diff}");
}

#[test]
fn shapes_whose_numbers_another_program_swapped_are_renumbered_not_changed() {
    let schema = schema();
    let before = talk_rooted("a", |_, _, _| {});
    // Slide 2's shapes swap numbers, their content and places unchanged.
    let after = talk_rooted("b", |slides, _, _| {
        slides[1].2[0].0 = 2;
        slides[1].2[1].0 = 1;
    });
    let pairing = pair(&schema, &before, &after);
    assert_eq!(pairing.renumbered.iter().collect::<Vec<_>>(), ["shape:2/1", "shape:2/2"]);
    let diff = diff_read_again(&schema, &before, &after).to_json();
    assert_eq!(diff["changed"], json!([]), "no text told as changed into the other's: {diff}");
    assert_eq!(diff["moved"], json!([]), "{diff}");
    assert_eq!(diff["renumbered"], json!(["shape:2/1", "shape:2/2"]), "{diff}");
    // A text edit of two shapes is no renumbering.
    let after = talk_rooted("b", |slides, _, _| {
        slides[1].2[0].1 = vec!["New title"];
        slides[1].2[1].1 = vec!["New body"];
    });
    assert!(pair(&schema, &before, &after).renumbered.is_empty());
}

/// Clips a ripple edit moved along a track (each now where another was, alike but for its
/// `start`, a field the schema marks `position`) are moved, not renumbered; clips whose
/// numbers swapped are still renumbered.
#[test]
fn clips_a_ripple_edit_moved_along_their_track_are_no_renumbering() {
    let schema = Schema::parse(
        &json!({
            "kdm": 1, "kit": "kit.reread", "schemaVersion": 1, "root": "Timeline",
            "types": {
                "Timeline": { "fields": { "clips": { "kind": "list", "of": "Clip" } } },
                "Clip": { "fields": {
                    "number": { "kind": "integer", "optional": true, "readOnly": true },
                    "start": { "kind": "number", "position": true },
                    "name": { "kind": "string" }
                }, "toolId": { "field": "number" } }
            }
        })
        .to_string(),
    )
    .unwrap();
    // Objects by the ids a load answers: their tool ids; the root by an id minted per read.
    let read = |mint: &str, clips: &[(u64, f64, &str)]| {
        let mut objects = Map::new();
        let ids: Vec<String> = clips.iter().map(|(n, _, _)| n.to_string()).collect();
        objects.insert(format!("{mint}-root"), json!({ "$type": "Timeline", "clips": ids }));
        for ((n, start, name), id) in clips.iter().zip(&ids) {
            objects.insert(id.clone(), json!({ "$type": "Clip", "number": n, "start": start, "name": name }));
        }
        json!({ "objects": objects })
    };
    let before = read("a", &[(1, 0.0, "x"), (2, 1.0, "x"), (3, 2.0, "x"), (4, 3.0, "x")]);
    // Clip 2 deleted, 3 and 4 one second earlier: 3 is where 2 was, 4 where 3 was.
    let after = read("b", &[(1, 0.0, "x"), (3, 1.0, "x"), (4, 2.0, "x")]);
    assert!(pair(&schema, &before, &after).renumbered.is_empty());
    let diff = diff_read_again(&schema, &before, &after).to_json();
    assert_eq!(diff["deleted"][0]["id"], "2", "{diff}");
    assert_eq!(diff["changed"].as_array().map(Vec::len), Some(2), "3 and 4 moved in time: {diff}");
    // Two clips that swap numbers, their other content differing, are renumbered.
    let swapped = read("b", &[(1, 0.0, "x"), (3, 1.0, "y"), (2, 2.0, "z"), (4, 3.0, "x")]);
    let before = read("a", &[(1, 0.0, "x"), (2, 1.0, "y"), (3, 2.0, "z"), (4, 3.0, "x")]);
    assert_eq!(pair(&schema, &before, &swapped).renumbered.iter().collect::<Vec<_>>(), ["2", "3"]);
}

/// regressions/issue-reread-text-run-ids: an object id inside a text's run formatting (a
/// picture fill of the letters, `attributes.fill`) is read through the pairing as ids in json are:
/// a file read again unchanged tells nothing; the fill's media changed is counted, the shape
/// unchanged. The text itself is never rewritten, even when it equals an id.
#[test]
fn ids_inside_a_texts_run_formatting_are_read_through_the_pairing() {
    let schema = Schema::parse(
        &json!({
            "kdm": 1, "kit": "kit.reread", "schemaVersion": 1, "root": "Deck",
            "types": {
                "Deck": { "fields": { "shapes": { "kind": "list", "of": "Shape" }, "media": { "kind": "list", "of": "Media" } } },
                "Media": { "fields": { "data": { "kind": "string" } } },
                "Shape": { "fields": {
                    "key": { "kind": "string", "readOnly": true },
                    "text": { "kind": "text", "marks": { "fill": { "expand": "none" } } }
                }, "toolId": { "field": "key", "prefix": "shape:" } }
            }
        })
        .to_string(),
    )
    .unwrap();
    let read = |mint: &str, data: &str, typed: Option<&str>| {
        let media = format!("{mint}-media");
        let deck = format!("{mint}-deck");
        let shapes: Vec<String> = (1..=2).map(|n| format!("{mint}-shape{n}")).collect();
        let mut objects = Map::new();
        objects.insert(deck, json!({ "$type": "Deck", "shapes": shapes, "media": [media.clone()] }));
        objects.insert(media.clone(), json!({ "$type": "Media", "data": data }));
        for (n, shape) in shapes.iter().enumerate() {
            let text = typed.map_or_else(|| format!("Shape {n}"), str::to_owned);
            objects.insert(shape.clone(), json!({ "$type": "Shape", "key": format!("{n}"), "text": [{ "insert": text, "attributes": { "fill": media } }] }));
        }
        json!({ "objects": objects })
    };
    let diff = diff_read_again(&schema, &read("a", "PNG1", None), &read("b", "PNG1", None));
    assert!(diff.is_empty() && diff.unnamed.is_empty(), "{}", diff.to_json());
    let diff = diff_read_again(&schema, &read("a", "PNG1", None), &read("b", "PNG2", None));
    assert_eq!(diff.to_json(), json!({ "created": [], "changed": [], "moved": [], "deleted": [], "unnamed": { "Media": { "changed": 1 } } }));
    // A text typed equal to an id of the read before stays text.
    let diff = diff_read_again(&schema, &read("a", "PNG1", Some("a-media")), &read("b", "PNG1", Some("a-media")));
    assert!(diff.is_empty() && diff.unnamed.is_empty(), "{}", diff.to_json());
}

/// Another program swaps two nodes' names, each
/// node keeping its place and position. Their contents without positions read as exchanged, but
/// their whole contents (places included) were not: two changes of `name`, no renumbering. Before,
/// the tool ids read as renumbered and a write on either was refused `unknown`.
#[test]
fn a_swap_of_names_is_two_changes_not_a_renumbering() {
    let schema = Schema::parse(
        &json!({
            "kdm": 1, "kit": "kit.reread", "schemaVersion": 1, "root": "Scene",
            "types": {
                "Scene": { "fields": { "nodes": { "kind": "list", "of": "Node" } } },
                "Node": { "fields": {
                    "key": { "kind": "integer", "readOnly": true },
                    "name": { "kind": "string" },
                    "location": { "kind": "json", "position": true }
                }, "toolId": { "field": "key" } }
            }
        })
        .to_string(),
    )
    .unwrap();
    let read = |mint: &str, nodes: &[(u64, &str, f64)]| {
        let mut objects = Map::new();
        let ids: Vec<String> = nodes.iter().map(|(key, _, _)| key.to_string()).collect();
        objects.insert(format!("{mint}-root"), json!({ "$type": "Scene", "nodes": ids }));
        for ((key, name, x), id) in nodes.iter().zip(&ids) {
            objects.insert(id.clone(), json!({ "$type": "Node", "key": key, "name": name, "location": [x, 0, 0] }));
        }
        json!({ "objects": objects })
    };
    let before = read("a", &[(1, "Cube", 0.0), (2, "Sphere", 3.0), (3, "Cone", 6.0)]);
    let after = read("b", &[(1, "Sphere", 0.0), (2, "Cube", 3.0), (3, "Cone", 6.0)]);
    assert!(pair(&schema, &before, &after).renumbered.is_empty());
    let diff = diff_read_again(&schema, &before, &after).to_json();
    let changed: Vec<(Value, Value)> = diff["changed"].as_array().unwrap().iter().map(|item| (item["id"].clone(), item["fields"].clone())).collect();
    assert_eq!(changed, vec![(json!("1"), json!(["name"])), (json!("2"), json!(["name"]))], "{diff}");
    // The keys exchanged with the nodes whole (each node, its name and location, now under the
    // other's key, in the other's place): a renumbering.
    let renumbered = read("b", &[(2, "Cube", 0.0), (1, "Sphere", 3.0), (3, "Cone", 6.0)]);
    assert_eq!(pair(&schema, &before, &renumbered).renumbered.iter().collect::<Vec<_>>(), ["1", "2"]);
}

/// The ambiguous case: two objects identical but for one field (no place in a list, no position)
/// whose values are exchanged read the same as a renumbering of the two. The safe reading is two
/// changes (a write on either is refused as `changed`, right under both readings).
#[test]
fn an_exchange_one_field_explains_is_two_changes() {
    let schema = Schema::parse(
        &json!({
            "kdm": 1, "kit": "kit.reread", "schemaVersion": 1, "root": "Pair",
            "types": {
                "Pair": { "fields": { "first": { "kind": "ref", "of": "Item", "owns": true }, "second": { "kind": "ref", "of": "Item", "owns": true } } },
                "Item": { "fields": { "number": { "kind": "integer", "readOnly": true }, "name": { "kind": "string" } }, "toolId": { "field": "number" } }
            }
        })
        .to_string(),
    )
    .unwrap();
    let read = |mint: &str, first: &str, second: &str| {
        json!({ "objects": {
            format!("{mint}-root"): { "$type": "Pair", "first": "1", "second": "2" },
            "1": { "$type": "Item", "number": 1, "name": first },
            "2": { "$type": "Item", "number": 2, "name": second }
        } })
    };
    let (before, after) = (read("a", "x", "y"), read("b", "y", "x"));
    assert!(pair(&schema, &before, &after).renumbered.is_empty());
    let diff = diff_read_again(&schema, &before, &after).to_json();
    assert_eq!(diff["changed"].as_array().map(Vec::len), Some(2), "{diff}");
}
