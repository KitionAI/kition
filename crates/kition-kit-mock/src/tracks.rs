// Copied from kition-sdk crates/kition-kit-mock/src/tracks.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Documents as timelines of clips (`KITION_KIT_MOCK_PARTS=tracks`): tracks holding clips, kept in
//! an object model whose tool ids survive edits and reloads, as a real video kit's do. The file is
//! the timeline as text, a track a line:
//!
//! ```text
//! V1:1=0+1|2=1+1@50|3=2+1!
//! V2:4=0+3
//! ```
//!
//! `V1` is the track's name (its tool id; `V1[label="Intro";mark=2]` gives the track's own
//! settings, its `attrs` map, each value JSON), `1=0+1` a clip numbered 1 (its tool id, an integer with
//! no prefix: the number a command takes, as the video kit's clip ids are) starting at 0 s and
//! lasting 1 s, `@50` its opacity when not 100, `!` a disabled clip, `{blur:5,glow:2}` its effects
//! in order, each a name and an amount (objects without tool ids the clip holds, named in paths by
//! their `name`: `pathName`, so a change of one reads `blur.amount`). Clips are in time order on
//! their track and do not overlap. A clip's `start` and `duration` are its position (the schema's
//! `position` flag): a ripple edit moves the clips after it by changing their `start`.
//!
//! The commands address clips by id (`clip.opacity`, `clip.trim`, `edit.rippleDelete`), by the
//! selection (`clip.disable`), or by place: a track named in `track` (`x-khp-role: place`) and the
//! playhead (`x-khp-reads: time`), set from a step's `at.time` (`timeline.selectAt`,
//! `timeline.razor`, `timeline.insert`). The kit answers `context.under` for those: the clips the
//! place names now, and where they are in their track's list.
//!
//! A track is a part (`agent.parts: ["track"]`, `at.part: { "track": "V1" }`, the first track when
//! none is set): `track.set` writes a key of the current track's `attrs` and names no object, as
//! a motion kit's comp settings and markers do. `clip.trim` also takes a clip by its place on the
//! current track, `"#2"` its second clip, a spelling the command declares (`x-khp-index: "#"`).

use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, UndoScope};

use crate::order::{self, ORDER};
use crate::projected::{self, PROJECTED};
use crate::space::{self, SPACE};
use crate::stack::{self, STACK};
use serde_json::{Map, Value, json};

/// The timeline's object model: tracks named by their name, clips by an integer (OM9) in a field
/// named `id`, as a video or motion kit's engine ids are (a load answers it in `fields` like any
/// other field: ).
pub const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Timeline",
  "types": {
    "Timeline": { "fields": { "tracks": { "kind": "list", "of": "Track" }, "reels": { "kind": "list", "of": "Reel" } } },
    "Reel": { "fields": {
      "name": { "kind": "string", "readOnly": true },
      "body": { "kind": "ref", "of": "Lane", "optional": true, "owns": true }
    }, "toolId": { "field": "name", "prefix": "reel:" } },
    "Lane": { "fields": {
      "markers": { "kind": "json", "optional": true },
      "shots": { "kind": "list", "of": "Shot" },
      "keys": { "kind": "list", "of": "Key" }
    } },
    "Shot": { "fields": {
      "id": { "kind": "integer", "readOnly": true },
      "amount": { "kind": "number" }
    }, "toolId": { "field": "id" } },
    "Key": { "batchIndependent": true, "fields": { "time": { "kind": "number" }, "value": { "kind": "number" } } },
    "Track": { "fields": {
      "name": { "kind": "string", "optional": true, "readOnly": true },
      "attrs": { "kind": "map", "optional": true },
      "clips": { "kind": "list", "of": "Clip" }
    }, "toolId": { "field": "name" } },
    "Clip": { "fields": {
      "id": { "kind": "integer", "optional": true, "readOnly": true },
      "start": { "kind": "number", "position": true },
      "duration": { "kind": "number", "position": true },
      "opacity": { "kind": "number" },
      "enabled": { "kind": "boolean" },
      "effects": { "kind": "list", "of": "Effect" }
    }, "toolId": { "field": "id" } },
    "Effect": { "fields": {
      "name": { "kind": "string" },
      "amount": { "kind": "number" }
    }, "pathName": "name" }
  }
}"#;

/// Whether documents have an object model with tool ids that survive reloads and commands that
/// name objects by place: timelines of clips, or scenes of nodes in space (`space.rs`, whose
/// functions the ones here hand a scene to).
pub static TRACKS: LazyLock<bool> =
    LazyLock::new(|| *PROJECTED || *ORDER || std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| matches!(value.trim(), "tracks" | "space" | "stack")));

/// The object model's schema: a timeline's, or a scene's.
pub fn schema() -> &'static str {
    if *PROJECTED {
        return projected::schema();
    }
    if *ORDER {
        return order::schema();
    }
    if *STACK {
        return stack::schema();
    }
    if *SPACE { space::schema() } else { SCHEMA }
}

const ROOT: &str = "timeline";

/// A clip as the file holds it.
#[derive(Clone, Debug, PartialEq)]
struct ClipLine {
    number: u64,
    start: f64,
    duration: f64,
    opacity: f64,
    enabled: bool,
    /// Its effects in order: a name and an amount.
    effects: Vec<(String, f64)>,
}

/// A track as the file holds it: its name, its settings (`attrs`) and its clips.
type TrackLine = (String, Map<String, Value>, Vec<ClipLine>);

/// A track's settings as the file writes them: `[k=<json>;…]`.
fn parse_attrs(text: &str) -> Result<Map<String, Value>, String> {
    let mut attrs = Map::new();
    for item in text.split(';').filter(|item| !item.is_empty()) {
        let (key, value) = item.split_once('=').ok_or_else(|| format!("`{item}` is no setting: `<key>=<json>`"))?;
        attrs.insert(key.trim().to_owned(), serde_json::from_str(value).map_err(|_| format!("`{value}` is no JSON value"))?);
    }
    Ok(attrs)
}

fn parse(text: &str) -> Result<(Vec<TrackLine>, Vec<crate::reels::ReelLine>), String> {
    let mut tracks = Vec::new();
    let mut reels = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(reel) = line.strip_prefix('@') {
            reels.push(crate::reels::parse(reel)?);
            continue;
        }
        let (name, clips) = line.split_once(':').ok_or_else(|| format!("`{line}` is no track: `<name>:<clips>`"))?;
        let (name, attrs) = match name.split_once('[') {
            Some((name, attrs)) => (name, parse_attrs(attrs.strip_suffix(']').ok_or_else(|| format!("`{name}` has no closing `]`"))?)?),
            None => (name, Map::new()),
        };
        let mut parsed = Vec::new();
        for clip in clips.split('|').filter(|clip| !clip.is_empty()) {
            let (clip, effects) = match clip.split_once('{') {
                Some((clip, effects)) => {
                    let effects = effects.strip_suffix('}').ok_or_else(|| format!("`{clip}` has no closing `}}`"))?;
                    let parsed: Vec<(String, f64)> = effects
                        .split(',')
                        .filter(|effect| !effect.is_empty())
                        .map(|effect| {
                            let (name, amount) = effect.split_once(':').ok_or_else(|| format!("`{effect}` is no effect: `<name>:<amount>`"))?;
                            Ok((name.trim().to_owned(), amount.parse::<f64>().map_err(|_| format!("`{amount}` is no amount"))?))
                        })
                        .collect::<Result<_, String>>()?;
                    (clip, parsed)
                }
                None => (clip, Vec::new()),
            };
            let (clip, enabled) = match clip.strip_suffix('!') {
                Some(clip) => (clip, false),
                None => (clip, true),
            };
            let (clip, opacity) = match clip.split_once('@') {
                Some((clip, opacity)) => (clip, opacity.parse::<f64>().map_err(|_| format!("`{opacity}` is no opacity"))?),
                None => (clip, 100.0),
            };
            let (number, span) = clip.split_once('=').ok_or_else(|| format!("`{clip}` is no clip: `<number>=<start>+<duration>`"))?;
            let (start, duration) = span.split_once('+').ok_or_else(|| format!("`{span}` is no span: `<start>+<duration>`"))?;
            parsed.push(ClipLine {
                number: number.trim().parse().map_err(|_| format!("`{number}` is no clip number"))?,
                start: start.parse().map_err(|_| format!("`{start}` is no start"))?,
                duration: duration.parse().map_err(|_| format!("`{duration}` is no duration"))?,
                opacity,
                enabled,
                effects,
            });
        }
        tracks.push((name.trim().to_owned(), attrs, parsed));
    }
    Ok((tracks, reels))
}

/// A new timeline replica from its text: object ids made from the file's names and numbers.
pub fn build(text: &str) -> Result<Replica, String> {
    if *PROJECTED {
        return projected::build(text);
    }
    if *ORDER {
        return order::build(text);
    }
    if *STACK {
        return stack::build(text);
    }
    if *SPACE {
        return space::build(text);
    }
    let (tracks, reels) = parse(text)?;
    let schema = Arc::new(Schema::parse(SCHEMA).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Timeline", &ObjectId::from_string(ROOT), Map::new())?;
        for (at, (name, attrs, clips)) in tracks.iter().enumerate() {
            let track = tx.create_with_id("Track", &ObjectId::from_string(format!("track-{name}")), Map::from_iter([("name".to_owned(), json!(name))]))?;
            for (key, value) in attrs {
                tx.map_set(&track, "attrs", key, value.clone())?;
            }
            tx.list_insert(&root, "tracks", at, &track)?;
            for (index, clip) in clips.iter().enumerate() {
                let object = tx.create_with_id("Clip", &ObjectId::from_string(format!("clip-{}", clip.number)), clip_fields(clip))?;
                tx.list_insert(&track, "clips", index, &object)?;
                for (at, (name, amount)) in clip.effects.iter().enumerate() {
                    let fields = Map::from_iter([("name".to_owned(), json!(name)), ("amount".to_owned(), json!(amount))]);
                    let effect = tx.create_with_id("Effect", &ObjectId::from_string(format!("effect-{}-{at}", clip.number)), fields)?;
                    tx.list_insert(&object, "effects", at, &effect)?;
                }
            }
        }
        for (at, reel) in reels.iter().enumerate() {
            crate::reels::create(tx, &root, at, reel)?;
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

fn clip_fields(clip: &ClipLine) -> Map<String, Value> {
    Map::from_iter([
        ("id".to_owned(), json!(clip.number)),
        ("start".to_owned(), json!(clip.start)),
        ("duration".to_owned(), json!(clip.duration)),
        ("opacity".to_owned(), json!(clip.opacity)),
        ("enabled".to_owned(), json!(clip.enabled)),
    ])
}

fn root(replica: &Replica) -> Result<ObjectId, String> {
    kition_kdm::batch::root_id(replica).ok_or_else(|| "the timeline has no root".to_owned())
}

fn tracks(replica: &Replica) -> Vec<ObjectId> {
    root(replica).ok().and_then(|root| replica.list(&root, "tracks").ok()).unwrap_or_default()
}

fn clips(replica: &Replica, track: &ObjectId) -> Vec<ObjectId> {
    replica.list(track, "clips").unwrap_or_default()
}

fn name(replica: &Replica, track: &ObjectId) -> String {
    replica.get(track, "name").ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

fn clip_line(replica: &Replica, clip: &ObjectId) -> ClipLine {
    let number = |field: &str| replica.get(clip, field).ok().and_then(|value| value.as_f64()).unwrap_or(0.0);
    ClipLine {
        number: replica.get(clip, "id").ok().and_then(|value| value.as_u64()).unwrap_or(0),
        start: number("start"),
        duration: number("duration"),
        opacity: replica.get(clip, "opacity").ok().and_then(|value| value.as_f64()).unwrap_or(100.0),
        enabled: replica.get(clip, "enabled").ok().and_then(|value| value.as_bool()).unwrap_or(true),
        effects: replica
            .list(clip, "effects")
            .unwrap_or_default()
            .iter()
            .map(|effect| {
                let name = replica.get(effect, "name").ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default();
                (name, replica.get(effect, "amount").ok().and_then(|value| value.as_f64()).unwrap_or(0.0))
            })
            .collect(),
    }
}

/// The timeline as the file holds it.
pub fn text_of(replica: &Replica) -> String {
    if *PROJECTED {
        return projected::text_of(replica);
    }
    if *ORDER {
        return order::text_of(replica).unwrap();
    }
    if *STACK {
        return stack::text_of(replica);
    }
    if *SPACE {
        return space::text_of(replica);
    }
    let mut lines = Vec::new();
    for track in tracks(replica) {
        let items: Vec<String> = clips(replica, &track)
            .iter()
            .map(|clip| {
                let clip = clip_line(replica, clip);
                let mut item = format!("{}={}+{}", clip.number, clip.start, clip.duration);
                if clip.opacity != 100.0 {
                    item.push_str(&format!("@{}", clip.opacity));
                }
                if !clip.enabled {
                    item.push('!');
                }
                if !clip.effects.is_empty() {
                    let effects: Vec<String> = clip.effects.iter().map(|(name, amount)| format!("{name}:{amount}")).collect();
                    item.push_str(&format!("{{{}}}", effects.join(",")));
                }
                item
            })
            .collect();
        let attrs: Vec<String> = replica.map_entries(&track, "attrs").unwrap_or_default().into_iter().map(|(key, value)| format!("{key}={value}")).collect();
        let attrs = if attrs.is_empty() { String::new() } else { format!("[{}]", attrs.join(";")) };
        lines.push(format!("{}{attrs}:{}", name(replica, &track), items.join("|")));
    }
    lines.extend(crate::reels::lines(replica));
    lines.join("\n")
}

/// How many tracks the timeline has.
pub fn count(replica: &Replica) -> usize {
    if *PROJECTED {
        return projected::count(replica);
    }
    if *ORDER {
        return order::count(replica);
    }
    if *STACK {
        return stack::count(replica);
    }
    if *SPACE {
        return space::count(replica);
    }
    tracks(replica).len()
}

/// The clip numbered `number`: it, its track and its index there.
fn clip(replica: &Replica, number: u64) -> Result<(ObjectId, ObjectId, usize), String> {
    for track in tracks(replica) {
        if let Some(index) = clips(replica, &track).iter().position(|clip| clip_line(replica, clip).number == number) {
            let clip = clips(replica, &track).swap_remove(index);
            return Ok((clip, track, index));
        }
    }
    Err(format!("no clip {number} in the timeline"))
}

/// Whether the timeline has the clip `id` (its number, as a number or a numeric string).
pub fn has_clip(replica: &Replica, id: &Value) -> bool {
    if *PROJECTED {
        return projected::has(replica, id);
    }
    if *ORDER {
        return order::has(replica, id.as_u64().unwrap_or_default());
    }
    if *STACK {
        return stack::has_layer(replica, id);
    }
    if *SPACE {
        return space::has_node(replica, id);
    }
    clip_number(id).is_some_and(|number| clip(replica, number).is_ok())
}

/// A clip id as a call gives it: a whole number, or one written as a string.
fn clip_number(id: &Value) -> Option<u64> {
    id.as_u64().or_else(|| id.as_str().and_then(|text| text.parse().ok()))
}

/// The place a clip's index spelling names (`"#2"`: the second clip of the current track),
/// counted from 0; `None` for any other value.
fn index_spelling(id: &Value) -> Option<usize> {
    id.as_str()?.strip_prefix('#')?.parse::<usize>().ok()?.checked_sub(1)
}

/// The track at `current` (the current part), else the first.
fn current_track(replica: &Replica, current: usize) -> Result<ObjectId, String> {
    let all = tracks(replica);
    all.get(current).or(all.first()).cloned().ok_or_else(|| "the timeline has no tracks".to_owned())
}

/// The clip number `id` names: an id, or an index spelling on the current track; for `clip.trim`
/// (`x-khp-index-numbers`), a number that is no clip's is the n-th clip of the current track too.
fn clip_named(replica: &Replica, id: &Value, current: usize, numbers: bool) -> Option<u64> {
    let nth = |index: usize| {
        let track = current_track(replica, current).ok()?;
        clips(replica, &track).get(index).map(|clip| clip_line(replica, clip).number)
    };
    match index_spelling(id) {
        Some(index) => nth(index),
        None if numbers => clip_number(id).filter(|number| clip(replica, *number).is_ok()).or_else(|| nth(usize::try_from(id.as_u64()?.checked_sub(1)?).ok()?)),
        None => clip_number(id),
    }
}

/// The place a number that is no clip's names on the current track (`x-khp-index-numbers`),
/// counted from 0.
fn index_number(replica: &Replica, id: &Value) -> Option<usize> {
    let number = id.as_u64()?;
    if clip(replica, number).is_ok() {
        return None;
    }
    usize::try_from(number.checked_sub(1)?).ok()
}

/// The index of the track named `name`, for a part `{ "track": name }`.
pub fn track_index(replica: &Replica, name_of: &str) -> Option<usize> {
    if *STACK {
        return None;
    }
    if *SPACE {
        return None;
    }
    tracks(replica).iter().position(|track| name(replica, track) == name_of)
}

/// The tracks a place names: the one named `track`, or every track.
fn tracks_named(replica: &Replica, track: Option<&str>) -> Result<Vec<ObjectId>, String> {
    let all = tracks(replica);
    match track {
        None => Ok(all),
        Some(wanted) => {
            all.into_iter().find(|track| name(replica, track) == wanted).map(|track| vec![track]).ok_or_else(|| format!("no track `{wanted}` in the timeline"))
        }
    }
}

/// The clips of `track` under `time` (a clip covers [start, start + duration)), with the window of
/// their indexes in the track's list: `[from, to)`, or for a gap, `from == to` where a clip put
/// there would go.
fn under_on(replica: &Replica, track: &ObjectId, time: f64) -> (Vec<u64>, usize, usize) {
    let listed = clips(replica, track);
    let mut found = Vec::new();
    let mut from = listed.len();
    let mut to = listed.len();
    for (index, id) in listed.iter().enumerate() {
        let clip = clip_line(replica, id);
        if clip.start + clip.duration <= time {
            continue;
        }
        if clip.start <= time {
            if found.is_empty() {
                from = index;
            }
            found.push(clip.number);
            to = index + 1;
        } else {
            if found.is_empty() {
                from = index;
                to = index;
            }
            break;
        }
    }
    (found, from, to)
}

/// A place in time on a track, as `context.under` gives it: the window of its clips' indexes, and
/// the span the guard replays against each clip's `start` and `duration`.
fn window_at(replica: &Replica, track: &ObjectId, time: f64) -> (Vec<u64>, Value) {
    let (found, from, to) = under_on(replica, track, time);
    let within = json!({ "parent": name(replica, track), "field": "clips", "from": from, "to": to,
        "time": { "from": time, "to": time, "start": "start", "duration": "duration" } });
    (found, within)
}

/// A clip's place on the current track by index (`"#2"`, or a number that is no clip's): the clip
/// there now and its window.
fn at_index(replica: &Replica, index: usize, current: usize) -> Result<(Option<u64>, Value), String> {
    let track = current_track(replica, current)?;
    let listed = clips(replica, &track);
    let found = listed.get(index).map(|clip| clip_line(replica, clip).number);
    let to = if found.is_some() { index + 1 } else { index };
    Ok((found, json!({ "parent": name(replica, &track), "field": "clips", "from": index, "to": to })))
}

/// `context.under`: what a call (`command`, `params`) depends on at `time` on the current track:
/// for a place-addressed command, its objects now and their windows in their tracks' clip lists
/// (a place in time with its span); for any command, the premises it can state exactly
///: `timeline.selectAt` reads no content of the clips it selects, `timeline.razor`
/// cuts where the clip under the time starts (not its length), `clip.opacity` and
/// `clip.copyOpacity` read and write opacities alone, wherever the clips are, `clip.effect` one
/// effect, `clip.paste` the source's opacity and the opacity of the clip under its place. `None`
/// for a command that names nothing by place and states no premise (`clip.trim` by id: every
/// field, every position).
pub fn under(replica: &Replica, command: &str, params: &Map<String, Value>, time: Option<f64>, current: usize) -> Result<Option<Value>, String> {
    if *PROJECTED {
        return projected::under(replica, command, params);
    }
    if *ORDER {
        return order::under(replica, command, params);
    }
    if *STACK {
        return stack::under(replica, command, params);
    }
    if *SPACE {
        return space::under(replica, command, params);
    }
    if command.starts_with("reel.") {
        return crate::reels::under(replica, command, params);
    }
    let opacity_of = |id: &Value| json!({ "id": id, "fields": ["opacity"], "positions": [] });
    let index_of = |value: &Value| index_spelling(value).or_else(|| if command == "clip.trim" { index_number(replica, value) } else { None });
    if let Some(index) = params.get("clip").and_then(index_of) {
        let (found, within) = at_index(replica, index, current)?;
        return Ok(Some(json!({ "objects": found.into_iter().collect::<Vec<_>>(), "within": [within] })));
    }
    match command {
        "clip.opacity" => {
            let clip = params.get("clip").cloned().unwrap_or(Value::Null);
            return Ok(Some(json!({ "objects": [], "premises": [opacity_of(&clip)] })));
        }
        "clip.effect" => {
            let clip = params.get("clip").cloned().unwrap_or(Value::Null);
            let effect = params.get("name").and_then(Value::as_str).unwrap_or_default();
            return Ok(Some(json!({ "objects": [], "premises": [{ "id": clip, "fields": [effect], "positions": [] }] })));
        }
        "clip.copyOpacity" => {
            let clip = params.get("clip").cloned().unwrap_or(Value::Null);
            let mut premises = vec![opacity_of(&clip)];
            let mut objects = Vec::new();
            let mut within = Vec::new();
            match params.get("from") {
                Some(from) if index_spelling(from).is_some() => {
                    let (found, window) = at_index(replica, index_spelling(from).unwrap_or_default(), current)?;
                    premises.extend(found.map(|number| opacity_of(&json!(number))));
                    objects.extend(found.map(|number| json!(number)));
                    within.push(window);
                }
                Some(from) => premises.push(opacity_of(from)),
                None => {}
            }
            return Ok(Some(json!({ "objects": objects, "within": within, "premises": premises })));
        }
        _ => {}
    }
    let time = match command {
        "timeline.selectAt" | "timeline.razor" | "clip.stamp" => time.ok_or("the place needs a time (`at.time`)")?,
        "timeline.insert" | "clip.paste" => params.get("at").and_then(Value::as_f64).ok_or("`at` is the time to insert at")?,
        _ => return Ok(None),
    };
    let track = params.get("track").and_then(Value::as_str);
    let mut objects = Vec::new();
    let mut within = Vec::new();
    for track in tracks_named(replica, track)? {
        let (found, window) = window_at(replica, &track, time);
        objects.extend(found.into_iter().map(|number| json!(number)));
        within.push(window);
    }
    let premises: Vec<Value> = match command {
        "timeline.selectAt" => objects.iter().map(|id| json!({ "id": id, "fields": [] })).collect(),
        "timeline.razor" => objects.iter().map(|id| json!({ "id": id, "positions": ["start"] })).collect(),
        "clip.paste" | "clip.stamp" => {
            objects.iter().map(|id| json!({ "id": id, "fields": ["opacity"], "positions": ["start"] })).chain(params.get("clip").map(opacity_of)).collect()
        }
        _ => Vec::new(),
    };
    Ok(Some(json!({ "objects": objects, "within": within, "premises": premises })))
}

/// The clips under the playhead (`time`) on `track` (every track when none), by number.
fn clips_at(replica: &Replica, track: Option<&str>, time: f64) -> Result<Vec<u64>, String> {
    let mut found = Vec::new();
    for track in tracks_named(replica, track)? {
        found.extend(under_on(replica, &track, time).0);
    }
    Ok(found)
}

/// What a timeline command did: whether it changed the document, its result, and the selection
/// it set (`timeline.selectAt`).
pub struct Edited {
    pub changed: bool,
    pub result: Option<Value>,
    pub selection: Option<Vec<String>>,
}

/// Runs one of the timeline's commands as `origin`, with the editor's playhead and selection.
#[allow(clippy::too_many_arguments)]
pub fn edit(
    replica: &mut Replica,
    command: &str,
    params: &Map<String, Value>,
    origin: &Origin,
    playhead: f64,
    selection: &[String],
    current: usize,
) -> Result<Edited, String> {
    if *PROJECTED {
        return projected::edit(replica, command, params, origin);
    }
    if *ORDER {
        return order::edit(replica, command, params, origin);
    }
    if *STACK {
        return stack::edit(replica, command, params, origin);
    }
    if *SPACE {
        return space::edit(replica, command, params, origin);
    }
    if let Some(edited) = crate::reels::edit(replica, command, params, origin) {
        return edited;
    }
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    let number = |key: &str| {
        params
            .get(key)
            .and_then(|id| clip_named(replica, id, current, command == "clip.trim"))
            .ok_or_else(|| format!("`{key}` is a clip id, a whole number, or `#<n>` the n-th clip of the track"))
    };
    let seconds =
        |key: &str| params.get(key).and_then(Value::as_f64).filter(|value| value.is_finite()).ok_or_else(|| format!("`{key}` is a number of seconds"));
    let done = |result: Option<Value>| Ok(Edited { changed: true, result, selection: None });
    match command {
        // The editor's, not the document's: the caller moves it ([`crate::kit`]).
        "playhead.set" => Ok(Edited { changed: false, result: None, selection: None }),
        "timeline.selectAt" => {
            let found = clips_at(replica, params.get("track").and_then(Value::as_str), playhead)?;
            Ok(Edited { changed: false, result: Some(json!({ "clips": found })), selection: Some(found.iter().map(u64::to_string).collect()) })
        }
        "clip.opacity" => {
            let (clip, _, _) = clip(replica, number("clip")?)?;
            let value = seconds("opacity").map_err(|_| "`opacity` is a number from 0 to 100".to_owned())?;
            replica.transact(origin, |tx| tx.set(&clip, "opacity", json!(value))).map_err(kdm)?;
            done(None)
        }
        "clip.copyOpacity" => {
            let (target, _, _) = clip(replica, number("clip")?)?;
            let (from, _, _) = clip(replica, number("from")?)?;
            let value = replica.get(&from, "opacity").ok().and_then(|value| value.as_f64()).unwrap_or(100.0);
            replica.transact(origin, |tx| tx.set(&target, "opacity", json!(value))).map_err(kdm)?;
            done(None)
        }
        "clip.paste" => {
            let (source, _, _) = clip(replica, number("clip")?)?;
            let value = replica.get(&source, "opacity").ok().and_then(|value| value.as_f64()).unwrap_or(100.0);
            let found = clips_at(replica, params.get("track").and_then(Value::as_str), seconds("at")?)?;
            let objects = found.iter().map(|number| clip(replica, *number).map(|(clip, _, _)| clip)).collect::<Result<Vec<_>, _>>()?;
            replica.transact(origin, |tx| objects.iter().try_for_each(|clip| tx.set(clip, "opacity", json!(value)))).map_err(kdm)?;
            done(Some(json!({ "pasted": found })))
        }
        "clip.stamp" => {
            let (source, _, _) = clip(replica, number("clip")?)?;
            let value = replica.get(&source, "opacity").ok().and_then(|value| value.as_f64()).unwrap_or(100.0);
            let found = clips_at(replica, None, playhead)?;
            let objects = found.iter().map(|number| clip(replica, *number).map(|(clip, _, _)| clip)).collect::<Result<Vec<_>, _>>()?;
            replica.transact(origin, |tx| objects.iter().try_for_each(|clip| tx.set(clip, "opacity", json!(value)))).map_err(kdm)?;
            done(Some(json!({ "stamped": found })))
        }
        "clip.effect" => {
            let (clip, _, _) = clip(replica, number("clip")?)?;
            let wanted = params.get("name").and_then(Value::as_str).ok_or("`name` names the effect")?;
            let amount = seconds("amount").map_err(|_| "`amount` is a number".to_owned())?;
            let effect = replica
                .list(&clip, "effects")
                .unwrap_or_default()
                .into_iter()
                .find(|effect| replica.get(effect, "name").ok().and_then(|value| value.as_str().map(str::to_owned)).as_deref() == Some(wanted))
                .ok_or_else(|| format!("the clip has no effect `{wanted}`"))?;
            replica.transact(origin, |tx| tx.set(&effect, "amount", json!(amount))).map_err(kdm)?;
            done(None)
        }
        "track.set" => {
            let key = params.get("key").and_then(Value::as_str).filter(|key| !key.is_empty()).ok_or("`key` names the setting")?;
            if key.contains([';', '=', '[', ']']) {
                return Err(format!("`{key}` holds a separator of the file"));
            }
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let track = current_track(replica, current)?;
            replica.transact(origin, |tx| tx.map_set(&track, "attrs", key, value.clone())).map_err(kdm)?;
            done(None)
        }
        "clip.trim" => {
            let (clip, _, _) = clip(replica, number("clip")?)?;
            let value = seconds("duration")?;
            replica.transact(origin, |tx| tx.set(&clip, "duration", json!(value))).map_err(kdm)?;
            done(None)
        }
        "clip.disable" => {
            let given: Vec<u64> = match params.get("clips").and_then(Value::as_array) {
                Some(ids) => ids.iter().map(|id| clip_number(id).ok_or_else(|| format!("{id} is no clip id"))).collect::<Result<_, _>>()?,
                None => selection.iter().filter_map(|id| id.parse().ok()).collect(),
            };
            if given.is_empty() {
                return Err("`clip.disable` disables the clips `clips`, else the selected ones, and nothing is selected".to_owned());
            }
            let objects = given.iter().map(|number| clip(replica, *number).map(|(clip, _, _)| clip)).collect::<Result<Vec<_>, _>>()?;
            replica.transact(origin, |tx| objects.iter().try_for_each(|clip| tx.set(clip, "enabled", json!(false)))).map_err(kdm)?;
            done(None)
        }
        "timeline.razor" => {
            let found = clips_at(replica, params.get("track").and_then(Value::as_str), playhead)?;
            let mut next = replica.objects_of_type("Clip").iter().map(|id| clip_line(replica, id).number).max().unwrap_or(0);
            let mut pieces = Vec::new();
            for number in found {
                let (object, track, index) = clip(replica, number)?;
                let line = clip_line(replica, &object);
                if line.start >= playhead {
                    continue;
                }
                next += 1;
                let right = ClipLine { number: next, start: playhead, duration: line.start + line.duration - playhead, ..line.clone() };
                replica
                    .transact(origin, |tx| {
                        tx.set(&object, "duration", json!(playhead - line.start))?;
                        let piece = tx.create("Clip", clip_fields(&right))?;
                        tx.list_insert(&track, "clips", index + 1, &piece)
                    })
                    .map_err(kdm)?;
                pieces.push(json!({ "left": number, "right": next }));
            }
            done(Some(json!({ "pieces": pieces })))
        }
        "timeline.insert" => {
            // A ripple insert: a clip of `duration` at `at` on `track`; every clip from `at` on
            // moves later by it.
            let at = seconds("at")?;
            let duration = seconds("duration")?;
            let track = tracks_named(replica, Some(params.get("track").and_then(Value::as_str).ok_or("`track` names the track")?))?.remove(0);
            let listed = clips(replica, &track);
            let index = listed.iter().position(|clip| clip_line(replica, clip).start >= at).unwrap_or(listed.len());
            let next = replica.objects_of_type("Clip").iter().map(|id| clip_line(replica, id).number).max().unwrap_or(0) + 1;
            let later: Vec<(ObjectId, f64)> = listed[index..].iter().map(|clip| (clip.clone(), clip_line(replica, clip).start)).collect();
            replica
                .transact(origin, |tx| {
                    for (clip, start) in &later {
                        tx.set(clip, "start", json!(start + duration))?;
                    }
                    let clip =
                        tx.create("Clip", clip_fields(&ClipLine { number: next, start: at, duration, opacity: 100.0, enabled: true, effects: Vec::new() }))?;
                    tx.list_insert(&track, "clips", index, &clip)
                })
                .map_err(kdm)?;
            done(Some(json!({ "clip": next })))
        }
        "edit.rippleDelete" => {
            let given: Vec<u64> = params
                .get("clips")
                .and_then(Value::as_array)
                .ok_or("`clips` lists the clips to delete")?
                .iter()
                .map(|id| clip_number(id).ok_or_else(|| format!("{id} is no clip id")))
                .collect::<Result<_, _>>()?;
            for number in given {
                let (object, track, index) = clip(replica, number)?;
                let gone = clip_line(replica, &object).duration;
                let later: Vec<(ObjectId, f64)> =
                    clips(replica, &track)[index + 1..].iter().map(|clip| (clip.clone(), clip_line(replica, clip).start)).collect();
                replica
                    .transact(origin, |tx| {
                        tx.list_remove(&track, "clips", index)?;
                        tx.delete(&object)?;
                        later.iter().try_for_each(|(clip, start)| tx.set(clip, "start", json!(start - gone)))
                    })
                    .map_err(kdm)?;
            }
            done(None)
        }
        "edit.undo" => {
            let scope = match params.get("scope").and_then(Value::as_str) {
                Some(scope) => UndoScope::parse(scope).ok_or("`scope` is person or agent")?,
                None => UndoScope::of(origin.kind).unwrap_or(UndoScope::Person),
            };
            if !replica.undo_in(scope).map_err(kdm)? {
                return Err("nothing to undo".to_owned());
            }
            done(None)
        }
        other => Err(format!("unknown command `{other}`")),
    }
}

/// The commands a timeline offers: what each takes, what names the clips it acts on
/// (`x-khp-role: targets`) or the place it acts at (`x-khp-role: place`), the editor state it
/// reads (`x-khp-reads`), and whether its effect depends on its clip's position
/// (`x-khp-position: independent` when it does not).
pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    if *PROJECTED {
        return projected::commands();
    }
    if *ORDER {
        return order::commands();
    }
    if *STACK {
        return stack::commands();
    }
    if *SPACE {
        return space::commands();
    }
    let clip = json!({ "type": "integer", "minimum": 1, "x-khp-role": "targets" });
    let track = json!({ "type": "string", "x-khp-role": "place" });
    let mut all = vec![
        (
            "timeline.selectAt",
            "Selects the clips under the playhead on `track` (every track when none).",
            false,
            json!({ "type": "object", "additionalProperties": false, "x-khp-reads": ["time"], "properties": { "track": track } }),
        ),
        (
            "timeline.razor",
            "Cuts the clips under the playhead on `track` (every track when none) in two.",
            true,
            json!({ "type": "object", "additionalProperties": false, "x-khp-reads": ["time"], "properties": { "track": track } }),
        ),
        (
            "timeline.insert",
            "Ripple-inserts a new clip of `duration` seconds at `at` on `track`; later clips move later.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["track", "at", "duration"], "properties": {
                "track": track, "at": { "type": "number", "x-khp-role": "place" }, "duration": { "type": "number" }
            } }),
        ),
        (
            "clip.opacity",
            "Sets a clip's opacity (0 to 100); it does not depend on where the clip is.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip", "opacity"], "x-khp-position": "independent", "properties": {
                "clip": clip, "opacity": { "type": "number" }
            } }),
        ),
        (
            "clip.trim",
            "Sets a clip's duration in seconds; `clip` is an id, `#n` or a number that is no clip's id (the n-th clip of the current track).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip", "duration"], "properties": {
                "clip": { "oneOf": [{ "type": "integer", "minimum": 1 }, { "type": "string" }], "x-khp-role": "targets", "x-khp-index": "#", "x-khp-index-numbers": true, "x-khp-types": ["Clip"] },
                "duration": { "type": "number" }
            } }),
        ),
        (
            "clip.copyOpacity",
            "Gives `clip` the opacity of `from` (an id, or `#n` the n-th clip of the current track).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip", "from"], "properties": {
                "clip": clip.clone(), "from": { "oneOf": [{ "type": "integer", "minimum": 1 }, { "type": "string" }], "x-khp-index": "#" }
            } }),
        ),
        (
            "clip.paste",
            "Gives the clips under `at` on `track` the opacity of `clip`.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip", "track", "at"], "properties": {
                "clip": clip.clone(), "track": track.clone(), "at": { "type": "number", "x-khp-role": "place" }
            } }),
        ),
        (
            "clip.stamp",
            "Gives the clips under the playhead on every track the opacity of `clip` (named by id: the playhead is the place).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip"], "x-khp-reads": ["time"], "properties": { "clip": clip.clone() } }),
        ),
        (
            "playhead.set",
            "Moves the playhead to `time` seconds; no edit.",
            false,
            json!({ "type": "object", "additionalProperties": false, "required": ["time"], "properties": { "time": { "type": "number" } } }),
        ),
        (
            "clip.effect",
            "Sets the amount of the clip's effect `name`.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clip", "name", "amount"], "properties": {
                "clip": clip.clone(), "name": { "type": "string" }, "amount": { "type": "number" }
            } }),
        ),
        (
            "track.set",
            "Sets the setting `key` of the current track (`at.part: { track }`, else the first) to `value`.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["key"], "x-khp-reads": ["part"], "properties": {
                "key": { "type": "string" }, "value": {}
            } }),
        ),
        (
            "clip.disable",
            "Disables the clips `clips`, else the selected clips.",
            true,
            json!({ "type": "object", "additionalProperties": false, "x-khp-reads": ["selection"], "properties": {
                "clips": { "type": "array", "items": { "type": "integer" }, "x-khp-role": "targets" }
            } }),
        ),
        (
            "edit.rippleDelete",
            "Deletes the clips `clips`; later clips on their tracks move earlier.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["clips"], "properties": {
                "clips": { "type": "array", "items": { "type": "integer" }, "x-khp-role": "targets" }
            } }),
        ),
    ];
    all.extend(crate::reels::commands());
    all
}
