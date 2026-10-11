# Harness Phase C Implementation Plan: Panes And Kits As Providers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In harness mode (`KITION_AGENT_HARNESS=1`), every pane and every kit
contributes to a turn only through the `kition_harness::provider::Provider`
seam: its own prompt sections and its own tools. The harness turn code names
no pane and no kit. Flag-off behavior is unchanged.

**Architecture:** A new module `crates/kition-agent/src/providers/` holds one
provider per concern. Tool bodies still run through the existing
`tools::execute` (the kit line owns `tools/kits.rs` and `tools/mod.rs`; this
plan only calls their public functions). `harness_turn::drive` builds the
system prompt and the tool registry with `kition_harness::provider::assemble`.
`session::drive` branches to the harness before computing the legacy context.
Parity is proven end to end: for each pane, the request the fake model
receives in harness mode carries the same tool names and the same prompt
paragraphs as in the original loop.

**Tech Stack:** Rust (`kition-agent`, `kition-harness`).

**Base:** `feat/kit-photo-tab` at or after `6b8af260`. Build with
`CARGO_INCREMENTAL=0`.

---

## What each provider takes over

Today the pane-specific behavior is spread over `session::tool_specs` (tool
hiding), `session::build_context` (context blocks), `prompts::tool_loop`
(general lines, table lines, and `prompts::pane` lines), and
`session::build_messages` / `harness_turn::system_prompt` (system prompt,
linked document, attachments, recent images). The table maps every piece to
exactly one provider. Order in the list is the order passed to `assemble`.

| Provider (file) | Applies | Prompt sections (in order) | Tools offered |
| --- | --- | --- | --- |
| `CoreProvider` (`core.rs`) | always | `prompts::linked_document(path)` when the active path is set; the attachment block; `prompts::recent_images`; the skill prompt; `prompts::task_mode`; `prompts::WEB_RESEARCH`; `prompts::execution_mode`; the general `tool_loop` lines (everything `tool_loop` emits before the table lines, without the `Available tools:` line); the request's `prompt_context` | every catalog tool not owned by another provider and whose `exposure` is not `hidden`, minus `web_search` when the model has no hosted search, minus `image_generation` when it has no hosted images |
| `DocumentProvider` (`document.rs`) | pane `document` | `prompts::pane("document")`; the active data document block (tables state present, data document set, no table) | `document_write` |
| `ImagesProvider` (`images.rs`) | pane is not `gallery` and the model has no hosted images | none | `image_search` |
| `TablesProvider` (`tables.rs`) | always | the active table context (tables state present); `prompts::table_execution` when a table is active; `prompts::table_plan` when a plan is attached; the three data-table `tool_loop` lines when `data_table_add_records` or `table_upsert_records` is offered; `prompts::pane("table")` when the pane is `table` | `data_table_*`, `table_upsert_records` |
| `WorkflowProvider` (`workflow.rs`) | pane `workflow` | `prompts::pane("workflow")`; `agent.workflow_prompt(id)` when a workflow id is set | none |
| `GalleryProvider` (`gallery.rs`) | pane `gallery` | `prompts::pane("gallery")` | none |
| `WhiteboardProvider` (`whiteboard.rs`) | pane `whiteboard` | `prompts::pane("whiteboard")`; `canvas::whiteboard_prompt(context)` when a context is attached | `whiteboard_propose_patch` when a context is attached |
| `DesignProvider` (`design.rs`) | pane `design` | `prompts::pane("design")`; `canvas::design_prompt(context)` when a context is attached | `design_propose_patch` when a context is attached |
| `LocalSourcesProvider` (`sources.rs`) | local sources attached | `sources::prompt_context` | `sources::tool_names(&run.local_sources)` |
| `KitsProvider` (`kits.rs`) | always | none (the kit linked-file prompt stays inside `prompts::linked_document`, which `CoreProvider` calls) | names in `tools::kits::tool_defs()` minus `tools::kits::unavailable(run)` |
| `McpProvider` (`mcp.rs`) | always | none | `run.agent.mcp().tools().await`, described as today (`[MCP <server>] ...`) |

"Owned by another provider" for `CoreProvider` means: `document_write`,
`image_search`, the data-table tools, `whiteboard_propose_patch`,
`design_propose_patch`, all `sources::CORE_TOOLS` and `sources::GIT_TOOLS`,
and every kit tool name. Keep this list in one function in `providers/mod.rs`
(`fn owned_elsewhere(name: &str) -> bool`) so it cannot drift per file.

After `assemble`, `harness_turn` appends one generic section,
`Available tools: <sorted names>`, computed from the assembled registry.

Pane names (`"document"`, `"table"`, ...) may appear inside provider files.
They must not appear in `harness_turn.rs` or in the harness branch of
`session.rs`.

## File structure

```text
crates/kition-agent/src/providers/mod.rs     TurnFacts, legacy tool adapter, owned_elsewhere, providers()
crates/kition-agent/src/providers/core.rs ... mcp.rs   one provider each (table above)
crates/kition-agent/src/harness_turn.rs      assemble() replaces legacy_tools + system_prompt
crates/kition-agent/src/session.rs           harness branch moves before build_context/tool_specs
crates/kition-agent/src/lib.rs               mod providers
crates/kition-agent/tests/agent_flow.rs      pane parity scenarios
```

---

### Task 1: The parity test, first

**Files:**
- Modify: `crates/kition-agent/tests/agent_flow.rs`

The fake provider records every request body. A helper runs one turn per mode
with a fake `answer(&["ok"])` script and returns the first request body.

- [ ] **Step 1: Record request bodies in the fake provider**

Change `fake_provider` (and the chat-completions fake, if separate) to push
each received JSON body into a shared `Arc<Mutex<Vec<Value>>>` returned with
the base URL: `async fn recording_provider(script: Vec<String>) -> (String, Arc<Mutex<Vec<Value>>>)`.
Keep the old `fake_provider` signature working by delegating.

- [ ] **Step 2: Write the parity scenarios**

```rust
fn tool_names(body: &Value) -> Vec<String> {
    let mut names: Vec<String> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str().or_else(|| tool["function"]["name"].as_str()).map(str::to_owned))
        .collect();
    names.sort();
    names
}

/// The prompt as a sorted set of non-empty lines, without the tool list
/// line, so the two modes can join sections differently.
fn prompt_lines(body: &Value) -> Vec<String> {
    let mut text = body["instructions"].as_str().unwrap_or_default().to_owned();
    for item in body["input"].as_array().into_iter().flatten() {
        if item["role"] == "system" || item["role"] == "developer" {
            text.push('\n');
            text.push_str(&item["content"].as_str().map(str::to_owned).unwrap_or_else(|| item["content"].to_string()));
        }
    }
    let mut lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Available tools:"))
        .map(str::to_owned)
        .collect();
    lines.sort();
    lines.dedup();
    lines
}

async fn first_request(harness_mode: bool, extra: Value) -> Value {
    let Harness { app, .. } = app_with(harness_mode);
    let session_id = new_session(&app).await;
    let (base_url, bodies) = recording_provider(vec![answer(&["ok"])]).await;
    stream(&app, session_id, &base_url, extra).await;
    let bodies = bodies.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    bodies.first().cloned().unwrap_or_default()
}

async fn assert_pane_parity(extra: Value) {
    let legacy = first_request(false, extra.clone()).await;
    let harness = first_request(true, extra.clone()).await;
    assert_eq!(tool_names(&harness), tool_names(&legacy), "tools differ for {extra}");
    assert_eq!(prompt_lines(&harness), prompt_lines(&legacy), "prompt differs for {extra}");
}

#[tokio::test(flavor = "multi_thread")]
async fn panes_offer_the_same_tools_and_prompt_on_the_harness() {
    for pane in ["document", "table", "workflow", "gallery"] {
        assert_pane_parity(json!({ "pane_context": pane })).await;
    }
    assert_pane_parity(json!({ "pane_context": "document", "active_document_path": "Notes/a.md" })).await;
    assert_pane_parity(json!({ "pane_context": "document", "execution_mode": "preview", "task_mode": "table" })).await;
}
```

Add whiteboard and design scenarios with valid contexts. Find valid
`whiteboard_context` and `design_context` examples in the existing tests or
e2e fixtures (`grep -rn "whiteboard_context\|design_context" crates e2e src`),
or build the smallest value that passes `canvas::validate_whiteboard_context`
/ `validate_design_context`:

```rust
    assert_pane_parity(json!({ "pane_context": "whiteboard", "whiteboard_context": <valid> })).await;
    assert_pane_parity(json!({ "pane_context": "design", "design_context": <valid> })).await;
```

(Write the literal JSON you found; do not leave placeholders.)

The legacy path sends the prompt as several system messages and the harness
as one; `prompt_lines` compares line sets, so this is fine. If the harness
legitimately differs in one line (for example the user message position),
fix the comparison helper, not by weakening it to a subset check.

- [ ] **Step 3: Run it**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent --test agent_flow panes_offer`
Expected: PASS already (the harness still reuses the legacy context). This
test is the guard for Task 2. If it fails now, the difference is an existing
parity bug: report it before continuing.

- [ ] **Step 4: Commit**

```bash
git add crates/kition-agent/tests/agent_flow.rs
git commit -m "Guard pane parity between the original loop and the harness"
```

### Task 2: The providers

**Files:**
- Create: `crates/kition-agent/src/providers/{mod,core,document,images,tables,workflow,gallery,whiteboard,design,sources,kits,mcp}.rs`
- Modify: `crates/kition-agent/src/lib.rs` (`mod providers;`)

- [ ] **Step 1: `providers/mod.rs`**

```rust
//! Everything a pane or kit adds to a harness turn, one provider each. The
//! harness turn assembles them and never names a pane or a kit.

mod core;
mod design;
mod document;
mod gallery;
mod images;
mod kits;
mod mcp;
mod sources;
mod tables;
mod whiteboard;
mod workflow;

use std::sync::Arc;

use kition_harness::provider::Provider;
use kition_harness::tool::ToolDef;
use serde_json::Value;

use crate::run::Run;

/// What the request says about this turn beyond `Run`.
#[derive(Debug, Clone, Default)]
pub struct TurnFacts {
    pub prompt_context: String,
    pub active_workflow_id: String,
    pub table_plan: Option<Value>,
    pub skills: Vec<crate::catalog::SkillDef>,
    pub hosted_web_search: bool,
    pub hosted_images: bool,
}

/// Builds one tool from a catalog or MCP spec; `None` when the harness cannot
/// offer it (logged by the caller's adapter).
pub type ToolFactory = Arc<dyn Fn(&kition_ai::engine::ToolSpec) -> Option<ToolDef> + Send + Sync>;

/// Tools a provider other than `CoreProvider` offers.
pub fn owned_elsewhere(name: &str) -> bool {
    matches!(
        name,
        "document_write" | "image_search" | "table_upsert_records" | "whiteboard_propose_patch" | "design_propose_patch"
    ) || name.starts_with("data_table_")
        || crate::sources::CORE_TOOLS.contains(&name)
        || crate::sources::GIT_TOOLS.contains(&name)
        || crate::tools::kits::tool_defs().iter().any(|tool| tool.name == name)
}

/// The providers of one turn, in assembly order.
pub fn providers(run: &Arc<Run>, facts: &Arc<TurnFacts>, factory: &ToolFactory) -> Vec<Arc<dyn Provider>> {
    vec![
        Arc::new(core::CoreProvider::new(run, facts, factory)),
        Arc::new(document::DocumentProvider::new(run, factory)),
        Arc::new(images::ImagesProvider::new(run, facts, factory)),
        Arc::new(tables::TablesProvider::new(run, facts, factory)),
        Arc::new(workflow::WorkflowProvider::new(run, facts)),
        Arc::new(gallery::GalleryProvider),
        Arc::new(whiteboard::WhiteboardProvider::new(run, factory)),
        Arc::new(design::DesignProvider::new(run, factory)),
        Arc::new(sources::LocalSourcesProvider::new(run, factory)),
        Arc::new(kits::KitsProvider::new(run, factory)),
        Arc::new(mcp::McpProvider::new(run, factory)),
    ]
}

/// The catalog spec of `name` as a model tool spec, if it exists.
pub fn catalog_spec(name: &str) -> Option<kition_ai::engine::ToolSpec> {
    crate::catalog::tool(name).map(|tool| kition_ai::engine::ToolSpec {
        name: tool.name.clone(),
        description: tool.description.clone(),
        input_schema: tool.input_schema.clone(),
    })
}
```

Each provider implements `kition_harness::provider::Provider`: `id()`,
`applies(&TurnScene)` (use `scene.pane` for pane checks), `prompt(&TurnScene)`,
and `tools(&TurnScene)`. Providers that own tools call the `ToolFactory` on
`catalog_spec(name)` for each owned name and keep the `Some` results.

- [ ] **Step 2: Implement each provider from the table**

One file per row of the table above. Copy the logic and the exact strings
from where they live today (`session::tool_specs`, `session::build_context`,
`session::active_data_document`, `prompts::tool_loop`, `prompts::pane`,
`harness_turn::system_prompt`); move shared helpers to `pub(crate)` instead of
duplicating them. In particular:

- Split `prompts::tool_loop` into `pub(crate) fn general_lines() -> Vec<String>`
  (all lines before the data-table ones, without `Available tools:`) and
  `pub(crate) fn table_lines() -> [&'static str; 3]`, and make the legacy
  `tool_loop` call both so the legacy output is byte-for-byte unchanged.
- `session::supports_hosted_web_search` / `supports_hosted_images` become
  `pub(crate)`; `session::drive` fills `TurnFacts` with them.
- `session::active_data_document` becomes `pub(crate)` for `DocumentProvider`.

Test each provider in its file with a unit test where it does not need a
`Run` (pure prompt functions); the parity test covers the rest.

- [ ] **Step 3: Build and commit**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent && CARGO_INCREMENTAL=0 cargo clippy -p kition-agent --all-targets -- -D warnings`

```bash
git add crates/kition-agent
git commit -m "Add a provider for every pane, local sources, kits, and MCP"
```

### Task 3: Assemble the harness turn from providers

**Files:**
- Modify: `crates/kition-agent/src/harness_turn.rs`, `crates/kition-agent/src/session.rs`

- [ ] **Step 1: Branch before the legacy context**

In `session::drive`, move the harness branch to right after the skills are
matched and the model checks pass (before `build_context` and `tool_specs`).
Build `TurnFacts` there (prompt context, workflow id, table plan, skills,
hosted support flags) and call
`harness_turn::drive(&run, session, &content, facts, turn_guard)`.
Emit the same `prompt.sent` timeline event with `turn_capabilities` computed
from the assembled tool specs (make `turn_capabilities` `pub(crate)`).

- [ ] **Step 2: Assemble in `harness_turn::drive`**

Replace `legacy_tools(...)` and `system_prompt(...)` with:

```rust
    let factory: ToolFactory = /* wraps the existing per-spec builder (registry body,
        unchecked_parameters, writes(), log_arguments, skip-on-failure warn) for one spec */;
    let scene = TurnScene {
        pane: run.pane.clone(),
        active_path: run.active_document_path.clone(),
        language: run.language.clone(),
        extra: Value::Null,
    };
    let assembly = match assemble(&prompts::system_prompt(&run.language), &providers(run, &facts, &factory), &scene).await {
        Ok(assembly) => assembly,
        Err(error) => {
            session::fail(run, "Execution failed", "final", &error).await;
            return;
        }
    };
    let names: Vec<String> = assembly.tools.specs().into_iter().map(|spec| spec.name).collect();
    let system = format!("{}\n\nAvailable tools: {}", assembly.system, names.join(", "));
```

The order of `Available tools:` names must match the legacy line's order
(legacy lists `tool_specs` order: catalog order, then MCP); sort both
identically if needed, the parity test ignores that line.

- [ ] **Step 3: No pane names in the harness turn**

Add a unit test in `harness_turn.rs` that reads its own source with
`include_str!("harness_turn.rs")` and asserts it contains none of
`"\"document\""`, `"\"table\""`, `"\"workflow\""`, `"\"gallery\""`,
`"\"whiteboard\""`, `"\"design\""`, `"photo_"`, `"kit."`.

- [ ] **Step 4: Run the parity test and the rest**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent`
Expected: all pass, including `panes_offer_the_same_tools_and_prompt_on_the_harness`
and the 7 existing agent_flow scenarios. A parity failure is a provider bug.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-agent
git commit -m "Assemble harness turns from providers"
```

### Task 4: Gates

- [ ] `pnpm check:desktop`, `python3 scripts/check-i18n.py`,
  `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`
- [ ] In `docs/superpowers/plans/2026-10-11-harness-agent-plan.md`, mark
  phase C done in the phase table with the commit range.
