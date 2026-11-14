// One-time reference capture only. The standalone regression runner never compiles this adapter.
use engine::Session;
use serde_json::{json, Value};
use std::io::{self, Read};
use std::sync::Arc;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let cases: Vec<Value> = serde_json::from_str(&input)?;
    let mut output = Vec::new();
    for case in cases {
        let mut session = Session {
            expr: Some(Arc::new(expr::Expressions)),
            expr_check: Some(expr::check_syntax),
            ..Default::default()
        };
        session.execute("file.newProject", json!({}))?;
        session.execute(
            "comp.new",
            json!({
                "name": "Comp 1", "width": case["width"], "height": case["height"],
                "frameRate": 30, "duration": 10, "open": true
            }),
        )?;
        let mut snapshots = Vec::new();
        for step in case["steps"].as_array().ok_or("missing steps")? {
            if let Some(command) = step["command"].as_str() {
                let result = session.execute(command, step["params"].clone());
                if step["error"] == true {
                    if result.is_ok() {
                        return Err(
                            format!("{}: {command} unexpectedly succeeded", case["id"]).into()
                        );
                    }
                } else {
                    result.map_err(|error| format!("{}: {command}: {error}", case["id"]))?;
                }
            } else {
                session.execute("time.set", json!({"time": step["time"]}))?;
                let info = session.execute("comp.info", json!({}))?;
                let mut properties = Vec::new();
                for query in step["queries"].as_array().ok_or("missing queries")? {
                    let mut params = query.clone();
                    if let Some(params) = params.as_object_mut() {
                        params.remove("fields");
                        params.remove("expected");
                    }
                    params["time"] = step["time"].clone();
                    params["timeBase"] = json!("comp");
                    let value = session.execute("prop.get", params)?;
                    let defaults = json!(["value", "animated"]);
                    let fields = query.get("fields").unwrap_or(&defaults);
                    let mut projected = serde_json::Map::new();
                    for field in fields.as_array().ok_or("query fields must be an array")? {
                        let field = field.as_str().ok_or("query field must be a string")?;
                        projected.insert(
                            field.to_owned(),
                            if field == "expressionError" {
                                json!(value.get(field).is_some())
                            } else {
                                value[field].clone()
                            },
                        );
                    }
                    properties.push(Value::Object(projected));
                }
                let id = session.active_comp_id().ok_or("no composition")?;
                let image = session.render(id, session.time(), Default::default());
                let background = session.active_comp().ok_or("no composition")?.background;
                snapshots.push(json!({
                    "label": step["checkpoint"], "info": info, "properties": properties,
                    "rgba": image.to_rgba8_over(background), "width": image.width, "height": image.height
                }));
            }
        }
        output.push(json!({"id": case["id"], "snapshots": snapshots}));
    }
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
