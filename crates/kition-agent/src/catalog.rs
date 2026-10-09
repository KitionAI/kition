//! The built-in tool and skill catalog, plus skills a workspace adds under
//! `.kition/agent/skills/<name>/SKILL.md`.

use std::path::Path;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const READ_ONLY: &str = "read-only";
pub const WORKSPACE_WRITE: &str = "workspace-write";

const WORKSPACE_SKILLS_DIR: &str = ".kition/agent/skills";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    pub permission: String,
    /// `direct_model_only` tools are offered only in their own pane.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub exposure: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub namespace: String,
}

impl ToolDef {
    pub fn writes(&self) -> bool {
        !self.permission.is_empty() && self.permission != READ_ONLY
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillDef {
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub system_prompt: String,
}

#[derive(Deserialize)]
struct Catalog {
    tools: Vec<ToolDef>,
    skills: Vec<SkillDef>,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalog.json")).unwrap_or(Catalog {
        tools: Vec::new(),
        skills: Vec::new(),
    })
});

/// Every built-in tool, sorted by name.
pub fn tools() -> &'static [ToolDef] {
    &CATALOG.tools
}

pub fn tool(name: &str) -> Option<&'static ToolDef> {
    CATALOG.tools.iter().find(|tool| tool.name == name)
}

/// Built-in skills overridden or extended by the workspace's own.
pub fn skills(workspace: &Path) -> Vec<SkillDef> {
    let mut merged = CATALOG.skills.clone();
    for skill in workspace_skills(workspace) {
        match merged
            .iter_mut()
            .find(|existing| existing.name.eq_ignore_ascii_case(&skill.name))
        {
            Some(existing) => *existing = skill,
            None => merged.push(skill),
        }
    }
    merged
}

/// Skills as the client sees them, without their prompts.
pub fn public_skills(skills: &[SkillDef]) -> Vec<SkillDef> {
    skills
        .iter()
        .map(|skill| SkillDef {
            system_prompt: String::new(),
            ..skill.clone()
        })
        .collect()
}

pub fn capabilities(workspace: &Path) -> Value {
    let tools: Vec<Value> = tools()
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "category": tool.category,
                "input_schema": tool.input_schema,
                "permission": tool.permission,
                "enabled": true,
            })
        })
        .collect();
    json!({
        "tools": tools,
        "skills": public_skills(&skills(workspace)),
        "adapters": [],
        "governance": {
            "permission_mode": WORKSPACE_WRITE,
            "sandbox_enabled": true,
            "shell_enabled": true,
        },
        "surfaces": {
            "http": true,
            "ndjson_stream": true,
            "local_source_access": true,
        },
    })
}

fn workspace_skills(workspace: &Path) -> Vec<SkillDef> {
    let Ok(entries) = std::fs::read_dir(workspace.join(WORKSPACE_SKILLS_DIR)) else {
        return Vec::new();
    };
    let mut skills: Vec<SkillDef> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let raw = std::fs::read_to_string(entry.path().join("SKILL.md")).ok()?;
            let skill = parse_skill(&entry.file_name().to_string_lossy(), &raw);
            (!skill.name.is_empty()).then_some(skill)
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn first_non_empty<'a>(values: &[Option<&'a String>]) -> &'a str {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// Parses a `SKILL.md` with optional `---` front matter.
pub fn parse_skill(folder: &str, raw: &str) -> SkillDef {
    let (meta, body) = split_front_matter(raw);
    let folder = folder.to_owned();
    let name = first_non_empty(&[meta.get("name"), Some(&folder)]).to_owned();
    let description = first_non_empty(&[meta.get("description"), Some(&name)]).to_owned();
    let mut triggers = parse_list(first_non_empty(&[
        meta.get("triggers"),
        meta.get("trigger"),
    ]));
    let tools = parse_list(first_non_empty(&[
        meta.get("tools"),
        meta.get("allowed_tools"),
        meta.get("allowed-tools"),
    ]));
    if triggers.is_empty() {
        triggers.push(name.clone());
    }
    let body = body.trim();
    SkillDef {
        system_prompt: if body.is_empty() {
            description.clone()
        } else {
            body.to_owned()
        },
        name,
        description,
        triggers,
        tools,
    }
}

fn split_front_matter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let raw = raw.replace("\r\n", "\n");
    let mut meta = std::collections::HashMap::new();
    let trimmed = raw.trim();
    if !trimmed.starts_with("---\n") {
        return (meta, raw);
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let Some(end) = (1..lines.len()).find(|&index| lines[index].trim() == "---") else {
        return (meta, raw);
    };
    let mut current = String::new();
    for line in &lines[1..end] {
        let trimmed_line = line.trim();
        if !current.is_empty()
            && let Some(item) = trimmed_line.strip_prefix("- ")
        {
            let item = item.trim().trim_matches(['"', '\'']);
            if !item.is_empty() {
                let entry: &mut String = meta.entry(current.clone()).or_default();
                if !entry.is_empty() {
                    entry.push(',');
                }
                entry.push_str(item);
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        if !key.is_empty() {
            current = key.clone();
            meta.insert(key, value.trim().trim_matches(['"', '\'']).to_owned());
        }
    }
    (meta, lines[end + 1..].join("\n"))
}

fn parse_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw
        .trim()
        .trim_matches(['[', ']'])
        .split([',', ';', '\u{ff0c}', '\u{ff1b}'])
    {
        let value = part.trim().trim_matches(['"', '\'']);
        if !value.is_empty() && !out.iter().any(|seen| seen.eq_ignore_ascii_case(value)) {
            out.push(value.to_owned());
        }
    }
    out
}

/// The skills that apply to a turn, decided by its context.
pub fn match_skills(
    skills: &[SkillDef],
    prompt: &str,
    has_table: bool,
    has_documents: bool,
) -> Vec<SkillDef> {
    let mut names = vec!["agent-chat-orchestrator", "project-design-system"];
    if requests_external_research(prompt) {
        names.push("deep-research");
    }
    if has_table {
        names.push("data-table-agent");
    }
    if has_table || has_documents {
        names.push("document-report-agent");
    }
    if contains_http_url(prompt) {
        names.push("web-archive-agent");
    }
    names
        .into_iter()
        .filter_map(|name| {
            skills
                .iter()
                .find(|skill| skill.name.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect()
}

/// The system prompt block for the enabled skills.
pub fn skill_prompt(skills: &[SkillDef]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut parts = vec![
        "The following Kition Agent skills were automatically enabled for this request. Follow their constraints."
            .to_owned(),
    ];
    for skill in skills {
        if !skill.system_prompt.trim().is_empty() {
            parts.push(format!(
                "<skill name=\"{}\">\n{}\n</skill>",
                skill.name, skill.system_prompt
            ));
        }
    }
    parts.join("\n\n")
}

fn requests_external_research(prompt: &str) -> bool {
    const PHRASES: &[&str] = &[
        "web search",
        "search the web",
        "internet search",
        "search online",
        "look up online",
        "find sources",
        "latest information",
        "latest data",
        "current information",
        "research online",
    ];
    let normalized = prompt.trim().to_lowercase();
    PHRASES.iter().any(|phrase| normalized.contains(phrase))
}

pub fn contains_http_url(text: &str) -> bool {
    text.match_indices("http").any(|(index, _)| {
        let rest = &text[index..];
        let after = rest
            .strip_prefix("https://")
            .or_else(|| rest.strip_prefix("http://"));
        after.is_some_and(|after| {
            after
                .chars()
                .next()
                .is_some_and(|c| !c.is_whitespace() && !matches!(c, ')' | '>' | '"' | '\''))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_without_browser_tools() {
        assert!(tools().len() > 30);
        assert!(tool("document_write").is_some_and(ToolDef::writes));
        assert!(tool("document_read").is_some_and(|tool| !tool.writes()));
        assert!(
            tools()
                .iter()
                .all(|tool| !tool.name.starts_with("browser_"))
        );
        let skills = skills(Path::new("/nonexistent"));
        assert!(skills.iter().any(|skill| skill.name == "deep-research"));
    }

    #[test]
    fn parses_skill_front_matter() {
        let skill = parse_skill(
            "folder",
            "---\nname: brand\ndescription: \"Brand voice\"\ntools:\n  - document_read\n  - document_write\n---\nUse the brand voice.\n",
        );
        assert_eq!(skill.name, "brand");
        assert_eq!(skill.description, "Brand voice");
        assert_eq!(skill.tools, ["document_read", "document_write"]);
        assert_eq!(skill.triggers, ["brand"]);
        assert_eq!(skill.system_prompt, "Use the brand voice.");
        let bare = parse_skill("notes", "Plain body");
        assert_eq!(bare.name, "notes");
        assert_eq!(bare.system_prompt, "Plain body");
    }

    #[test]
    fn matches_skills_from_context() {
        let all = skills(Path::new("/nonexistent"));
        let names = |list: Vec<SkillDef>| list.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert!(names(match_skills(&all, "hello", false, false)).is_empty());
        assert_eq!(
            names(match_skills(
                &all,
                "save https://example.com/a",
                true,
                false
            )),
            [
                "data-table-agent",
                "document-report-agent",
                "web-archive-agent"
            ]
        );
        assert!(contains_http_url("see http://x.y"));
        assert!(!contains_http_url("http:// nothing"));
    }
}
