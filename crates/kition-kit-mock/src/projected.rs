// Copied from kition-sdk crates/kition-kit-mock/src/projected.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A source-text document whose sections and lines exist only in the kit's read projection.
use std::sync::{Arc, LazyLock};

use kition_kdm::projection::{ProjectedObject, ProjectedPlace};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

pub static PROJECTED: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PROJECTED").is_ok());
pub const ROOT: &str = "document";
const SCHEMA: &str = r#"{
 "kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Document","types":{
  "Document":{"fields":{"text":{"kind":"string","sample":false},"sections":{"kind":"list","of":"Section"}},"structuralConsequences":[{"container":"Document","on":["create","delete","move","rename","set"],"fields":["text"]}]},
  "Section":{"projected":true,"toolId":{"field":"key","prefix":"section:"},"label":"title","fields":{"key":{"kind":"string","readOnly":true},"title":{"kind":"string"},"starred":{"kind":"boolean"},"lines":{"kind":"list","of":"Line"}},"projectedOps":{
   "set.title":{"command":"section.set","params":{"id":"target","title":"value"}},
   "set.starred":{"command":"section.starred","params":{"id":"target","starred":"value"}},
   "create":{"command":"section.create","params":{"id":"id","title":"fields.title","starred":"fields.starred","key":"fields.key","at":"at"}},
   "delete":{"command":"section.delete","params":{"id":"target"}},
   "list.move":{"command":"section.move","params":{"id":"target","to":"to"}}
  }},
  "Line":{"projected":true,"toolId":{"field":"key","prefix":"line:"},"label":"text","text":"text","fields":{"key":{"kind":"string","readOnly":true},"text":{"kind":"string"}},"projectedOps":{
   "set.text":{"command":"line.set","params":{"id":"target","text":"value"}},
   "text.set":{"command":"line.set","params":{"id":"target","text":"text"}},
   "create":{"command":"line.add","params":{"id":"id","text":"fields.text","key":"fields.key","in":"in","at":"at"}},
   "delete":{"command":"line.delete","params":{"id":"target"}},
   "list.move":{"command":"line.move","params":{"id":"target","in":"in","to":"to"}}
  }}
 }
}"#;

pub fn schema() -> &'static str {
    static PLACED: LazyLock<String> = LazyLock::new(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
        match std::env::var("KITION_KIT_MOCK_PROJECTED_PLACE").as_deref() {
            Ok("tree") => schema["types"]["Document"]["fields"]["sections"]["kind"] = json!("tree"),
            Ok("ref") => {
                schema["types"]["Section"]["fields"]["lines"] = json!({"kind":"ref","of":"Line","owns":true,"optional":true});
                schema["types"]["Line"]["projectedOps"]["ref.set"] = json!({"command":"line.move","params":{"id":"target","in":"in"}});
            }
            _ => {}
        }
        schema.to_string()
    });
    &PLACED
}

pub fn build(text: &str) -> Result<Replica, String> {
    parse(text)?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        tx.create_with_id("Document", &ObjectId::from_string(ROOT), json!({"text":text}).as_object().unwrap().clone())?;
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

#[derive(Clone)]
struct Section {
    key: String,
    title: String,
    lines: Vec<(String, String)>,
}

fn parse(text: &str) -> Result<Vec<Section>, String> {
    let mut sections: Vec<Section> = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=').ok_or("a projected source line is `<key>=<text>`")?;
        if let Some(key) = key.strip_prefix('#') {
            if key.is_empty() || !ids.insert(format!("section:{key}")) {
                return Err("duplicate or empty section key".into());
            }
            sections.push(Section { key: key.into(), title: value.into(), lines: Vec::new() });
        } else {
            if key.is_empty() || !ids.insert(format!("line:{key}")) {
                return Err("duplicate or empty line key".into());
            }
            sections.last_mut().ok_or("a line needs a section")?.lines.push((key.into(), value.into()));
        }
    }
    Ok(sections)
}

pub fn text_of(replica: &Replica) -> String {
    replica.get(&ObjectId::from_string(ROOT), "text").unwrap().as_str().unwrap().to_owned()
}

pub fn objects(replica: &Replica) -> Result<Vec<ProjectedObject>, String> {
    let mut objects = Vec::new();
    let sections = parse(&text_of(replica))?;
    let tree = std::env::var("KITION_KIT_MOCK_PROJECTED_PLACE").as_deref() == Ok("tree");
    for (index, section) in sections.iter().enumerate() {
        let id = format!("section:{}", section.key);
        objects.push(ProjectedObject {
            id: id.clone(),
            ty: "Section".into(),
            fields: json!({"key":section.key,"title":section.title.trim_start_matches('!'),"starred":section.title.starts_with('!')})
                .as_object()
                .unwrap()
                .clone(),
            at: Some(ProjectedPlace {
                parent: ROOT.into(),
                field: "sections".into(),
                index: if tree && index > 0 { index - 1 } else { index },
                node: if tree && index > 0 { Some(format!("section:{}", sections[0].key)) } else { None },
            }),
        });
        for (index, (key, text)) in section.lines.iter().enumerate() {
            objects.push(ProjectedObject {
                id: format!("line:{key}"),
                ty: "Line".into(),
                fields: json!({"key":key,"text":text}).as_object().unwrap().clone(),
                at: Some(ProjectedPlace { parent: id.clone(), field: "lines".into(), index, node: None }),
            });
        }
    }
    Ok(objects)
}

pub fn count(replica: &Replica) -> usize {
    parse(&text_of(replica)).unwrap().len()
}
pub fn has(replica: &Replica, id: &Value) -> bool {
    objects(replica).unwrap().iter().any(|object| Some(object.id.as_str()) == id.as_str())
}

fn resolve(sections: &[Section], address: &str) -> Option<String> {
    if address.starts_with("line:") || address.starts_with("section:") {
        return Some(address.into());
    }
    if let Some(index) = address.strip_prefix('#').and_then(|index| index.parse::<usize>().ok()).and_then(|index| index.checked_sub(1)) {
        return sections.iter().flat_map(|section| &section.lines).nth(index).map(|(key, _)| format!("line:{key}"));
    }
    sections.iter().flat_map(|section| &section.lines).find(|(_, text)| text == address).map(|(key, _)| format!("line:{key}"))
}

pub fn under(replica: &Replica, _command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    let Some(address) = params.get("id").and_then(Value::as_str) else { return Ok(None) };
    let sections = parse(&text_of(replica))?;
    let Some(id) = resolve(&sections, address) else { return Ok(Some(json!({"objects":[],"within":[]}))) };
    let mut within = Vec::new();
    if address.starts_with('#') {
        for section in &sections {
            if let Some(index) = section.lines.iter().position(|(key, _)| id == format!("line:{key}")) {
                within.push(json!({"parent":format!("section:{}",section.key),"field":"lines","from":index,"to":index+1}));
            }
        }
    }
    Ok(Some(json!({"objects":[id],"within":within,"premises":[{"id":id,"fields":[if id.starts_with("line:") {"text"} else {"title"}],"positions":[]}]})))
}

pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    let before = text_of(replica);
    let mut sections = parse(&before)?;
    let address = params.get("id").and_then(Value::as_str).unwrap_or_default();
    let id = resolve(&sections, address).unwrap_or_else(|| address.into());
    let field = |name: &str| params.get(name).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("missing `{name}`"));
    let position = |name: &str, length: usize| {
        params
            .get(name)
            .and_then(Value::as_u64)
            .map_or(Ok(length), |index| if index as usize <= length { Ok(index as usize) } else { Err("index out of range".to_owned()) })
    };
    let section_at = sections.iter().position(|section| id == format!("section:{}", section.key));
    let line_at = sections.iter().enumerate().find_map(|(s, section)| section.lines.iter().position(|(key, _)| id == format!("line:{key}")).map(|i| (s, i)));
    let mut result_id = id.clone();
    match command {
        "line.set" => sections[line_at.ok_or("line not found")?.0].lines[line_at.unwrap().1].1 = field("text")?,
        "line.delete" => {
            let (s, i) = line_at.ok_or("line not found")?;
            sections[s].lines.remove(i);
        }
        "line.add" => {
            let parent = params.get("in").and_then(Value::as_str).unwrap_or("section:s.lines").trim_end_matches(".lines");
            let s = sections.iter().position(|section| parent == format!("section:{}", section.key)).ok_or("destination section not found")?;
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .or_else(|| id.strip_prefix("line:"))
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("new{}", sections.iter().map(|s| s.lines.len()).sum::<usize>()));
            result_id = format!("line:{key}");
            let at = position("at", sections[s].lines.len())?;
            sections[s].lines.insert(at, (key, field("text")?));
        }
        "line.move" => {
            let (s, i) = line_at.ok_or("line not found")?;
            let parent = params.get("in").and_then(Value::as_str).map(|s| s.trim_end_matches(".lines"));
            let destination = match parent {
                Some(parent) => sections.iter().position(|section| parent == format!("section:{}", section.key)).ok_or("destination section not found")?,
                None => s,
            };
            let line = sections[s].lines.remove(i);
            let to = position("to", sections[destination].lines.len())?;
            sections[destination].lines.insert(to, line);
        }
        "section.set" => {
            let section = &mut sections[section_at.ok_or("section not found")?];
            section.title = format!("{}{}", if section.title.starts_with('!') { "!" } else { "" }, field("title")?);
        }
        "section.starred" => {
            let section = &mut sections[section_at.ok_or("section not found")?];
            section.title = format!(
                "{}{}",
                if params.get("starred").and_then(Value::as_bool).ok_or("missing starred")? { "!" } else { "" },
                section.title.trim_start_matches('!')
            );
        }
        "section.delete" => {
            sections.remove(section_at.ok_or("section not found")?);
        }
        "section.create" => {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .or_else(|| id.strip_prefix("section:"))
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("new{}", sections.len()));
            result_id = format!("section:{key}");
            let at = position("at", sections.len())?;
            sections.insert(
                at,
                Section {
                    key,
                    title: format!("{}{}", if params.get("starred").and_then(Value::as_bool).unwrap_or(false) { "!" } else { "" }, field("title")?),
                    lines: Vec::new(),
                },
            );
        }
        "section.move" => {
            let section = sections.remove(section_at.ok_or("section not found")?);
            let to = position("to", sections.len())?;
            sections.insert(to, section);
        }
        _ => return Err(format!("unknown projected command `{command}`")),
    }
    let text = sections
        .iter()
        .flat_map(|s| std::iter::once(format!("#{}={}", s.key, s.title)).chain(s.lines.iter().map(|(key, text)| format!("{key}={text}"))))
        .collect::<Vec<_>>()
        .join("\n");
    parse(&text)?;
    replica.transact(origin, |tx| tx.set(&ObjectId::from_string(ROOT), "text", json!(text))).map_err(|error| error.to_string())?;
    Ok(Edited { changed: text != before, result: Some(json!({"id":result_id})), selection: None })
}

pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    [
        ("line.set", "text"),
        ("line.delete", ""),
        ("line.add", "text"),
        ("line.move", ""),
        ("section.set", "title"),
        ("section.starred", "starred"),
        ("section.delete", ""),
        ("section.create", "title"),
        ("section.move", ""),
    ]
    .into_iter()
    .map(|(command, field)| {
        let line=command.starts_with("line.");
        let id=json!({"type":"string","x-khp-role":"targets","x-khp-types":[if line {"Line"} else {"Section"}],"x-khp-name":if line {"text"} else {"title"},"x-khp-index":"#"});
        let mut properties = json!({"id":id,"in":{"type":"string"},"key":{"type":"string"},"at":{"type":"integer"},"to":{"type":"integer"}});
        if !field.is_empty() {
            properties[field] = json!({"type":if field=="starred" {"boolean"} else {"string"}});
        }
        (command, "Edits the source through a projected object.", true, json!({"type":"object","properties":properties}))
    })
    .collect()
}
