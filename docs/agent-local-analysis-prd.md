# Agent Local Analysis Folders PRD

Status: Implemented

Owner: Kition Agent

Last updated: 2026-08-12

## 1. Summary

Kition Agent can use one or more user-selected local folders as read-only evidence while creating or updating content in the current Kition workspace.

The feature is designed for complex research and production tasks such as understanding a large codebase, tracing an API, comparing implementations, validating version history, and generating a document from multiple local sources. It improves retrieval through precise lexical tools and multi-step Agent behavior without requiring embeddings, a vector database, or a persistent repository index.

The implementation follows the useful parts of the Codex local-workspace model: fuzzy path discovery over ignore-aware candidates, hierarchical `AGENTS.override.md` and `AGENTS.md` instructions, bounded reads, explicit tool results, and continued Agent execution after a failed edit. It does not copy Codex internals or require a BM25 or vector layer. Kition uses its own public runtime contract and read-only source boundary.

## 2. Problem

Attaching a folder is not sufficient by itself. A complex folder may contain thousands of files, long source files, nested project rules, generated output, ignored files, and version history. A simple substring search can find an isolated match but often fails to establish complete evidence across entry points, definitions, consumers, tests, configuration, documentation, and prior versions.

The product needs to help the Agent complete the user's task, not merely return a list of search results.

## 3. Goals

- Let a user explicitly attach up to eight local folders to an Agent session.
- Keep attached folders read-only and separate from the current Kition write target.
- Improve file discovery with fuzzy path matching.
- Improve content discovery with literal and regular-expression search, path filters, line locations, and bounded context.
- Let the Agent read exact line ranges from long files and continue from an explicit next range.
- Respect Git ignore behavior when the attached folder is a Git repository.
- Apply project instructions from `AGENTS.override.md` and `AGENTS.md` from the source root through the relevant file directory.
- Provide bounded, structured, read-only Git status and history inspection when a source is a Git repository.
- Preserve traceability with `source://` paths and line numbers.
- Prevent local source contents from being persisted in Agent tool-call output or timeline events.
- Continue writing all generated artifacts only to the current Kition workspace.
- Treat a requested document update as incomplete until the workspace write succeeds.
- Make whole-document rewrites reliable even when the source document is longer than a short timeline preview.

## 4. Non-goals

- Vector databases or embedding models.
- Persistent semantic indexes of local folders.
- Background indexing services.
- A general-purpose shell for attached folders.
- Editing, deleting, moving, checking out, committing, or otherwise modifying attached folders.
- Automatically changing the current Kition workspace or write target.
- A traditional search-results screen that requires the user to manage retrieval manually.
- Persisting local source file contents, instruction contents, diffs, or Git output in Agent history.
- Requiring BM25, embeddings, semantic reranking, or a vector store in the initial implementation.

## 5. User experience

### 5.1 Workspace model

The document, table, workflow, or other active Kition surface remains the output workspace. The Agent composer contains one context tray for the current document, explicit workspace references, documents attached through the composer, and attached read-only local folders.

The current document appears once using the same removable file-chip pattern as other document references. Explicit references to the same document are deduplicated. Local folders and document references use the same compact item pattern and removal behavior.

A compact `+` menu before the model picker provides the entry points for a local read-only folder or a workspace document reference. The context tray renders only when context exists, so an empty tray does not consume composer space. Summary labels such as a separate current-document row or an analysis-folder count are not repeated outside the tray.

Each attached source displays:

- The folder label.
- A read-only indicator.
- A remove action.
- No host path in normal product UI or Agent output.

The user can attach another folder until the eight-folder limit is reached. Folder management remains in a compact, height-bounded context tray so larger context sets scroll inside the tray instead of shrinking the composer input.

### 5.2 Consent

The desktop folder picker is the authority boundary. A folder becomes available to the Agent only after the user selects or confirms it. A local path typed into the prompt does not grant access by itself.

Folder grants are device-local and scoped to the Kition workspace and Agent session. They are not portable workspace data.

### 5.3 Agent behavior

For a complex task, the Agent should:

1. Establish a plan when planning tools are available.
2. Inspect the source root and applicable project instructions.
3. Discover likely files and directories through fuzzy path search.
4. Search file contents using focused literal or regular-expression queries.
5. Read bounded line ranges around relevant evidence.
6. Follow important definitions into consumers and related configuration, tests, and documentation.
7. Use Git history only when chronology, ownership, working-tree state, or version comparison matters.
8. Verify evidence coverage before generating the requested result.
9. Write the deliverable to the current Kition workspace.
10. If a workspace edit fails, inspect the latest file state and retry with the appropriate write tool before claiming completion.

The completion standard is task evidence quality, not the speed of returning a fixed number of search hits.

## 6. Functional requirements

### FR-1: Attach local analysis folders

- The client sends each selected source with an ID, label, environment-native root path, and `access: "read"`.
- The runtime accepts no more than eight sources per turn.
- The runtime rejects duplicate IDs, invalid IDs, invalid directories, non-absolute root paths, and any access mode other than read.
- Equivalent real paths are deduplicated.

### FR-2: Virtual paths

- All model-visible source paths use `source://<source-id>/<relative-path>`.
- Runtime errors, summaries, events, and artifacts must not expose the host root path.
- Relative paths must remain inside the selected source after symlink resolution.

### FR-3: Directory listing

- The Agent can list one directory level at a time.
- Results include virtual path, entry type, size, and modification time.
- Sensitive credential files, symlinks, ignored paths, and known high-noise build or dependency directories are omitted.

### FR-4: Fuzzy path discovery

- The Agent can fuzzy-search file and directory paths across one or all attached sources.
- Search supports file, directory, or combined results.
- Search supports optional include and exclude `**` glob filters.
- Results are ranked by path match quality and include matched character positions.
- Candidate enumeration is bounded and reports when its budget is reached.

### FR-5: Content search

- Search supports literal and regular-expression modes.
- Case behavior supports explicit control and smart-case defaults.
- Search supports include and exclude `**` glob filters.
- Each match includes virtual path, line, column, end column, matching line, and bounded surrounding context.
- Per-file and total result limits are independently bounded.
- The runtime scans the bounded candidate set before ranking and truncating results; it must not stop solely because the return limit has been filled.
- Search reports scanned candidates, scanned bytes, total collected matches, and budget exhaustion.

### FR-6: Line-range reading

- Reads use a one-based `start_line` and bounded `line_count`.
- Results contain numbered lines, total file line count, actual start and end lines, truncation state, and `next_start_line` when more content is available.
- Results include file size and modification time.
- Binary, oversized, invalid UTF-8, sensitive, and non-regular files are rejected.

### FR-7: Ignore behavior

- Git sources use Git ignore semantics for candidate discovery.
- Non-Git sources use bounded traversal and skip symlinks, dependency directories, build output, caches, editor metadata, and other known noise.
- Explicit include and exclude filters are applied after safe candidate discovery.

### FR-8: Project instructions

- `AGENTS.override.md` takes precedence over `AGENTS.md` in the same directory.
- Root instructions are provided when a source is attached.
- When reading a nested file, instructions are applied from the source root through that file's directory.
- Deeper instructions take precedence over parent instructions.
- The combined instruction content is bounded to 32 KiB per turn-level instruction context.
- Instruction provenance uses virtual paths.

### FR-9: Read-only Git inspection

When an attached source is a supported Git repository, the Agent may use structured tools for:

- Working-tree status.
- Recent commit history, optionally limited to one path.
- Commit metadata, a diff limited to one path, or file content at a revision.
- Blame for a bounded range of up to 500 lines.

Git operations must:

- Use validated revisions and relative paths.
- Reject option injection and traversal.
- Disable optional locks and external diff execution.
- Use hard time and output budgets.
- Filter sensitive paths.
- Never expose arbitrary Git arguments or a shell.
- Never modify repository state.

### FR-10: Agent research policy

- Complex local-source tasks should use a plan when the planning tool is available.
- The Agent should search again with different terms or follow symbol relationships when evidence is incomplete.
- Before completion, the Agent should check entry points, key definitions and consumers, and adjacent tests, configuration, or documentation when applicable.
- Important conclusions should be traceable to virtual paths and line numbers.

### FR-11: Privacy-safe execution history

- Local source contents may be sent to the selected model as active tool results.
- Local source contents, project instruction contents, Git output, snippets, and diffs must not be stored in Agent tool-call output or timeline event data.
- Persisted execution history may contain privacy-safe metadata such as virtual paths, line ranges, counts, limits, and truncation flags.
- The raw host root path must not be stored in portable Kition workspace data.

### FR-12: Write isolation

- Attached sources cannot be passed to workspace filesystem, document, shell, patch, or artifact write tools.
- All generated documents and artifacts remain inside the current Kition workspace.
- Removing a source revokes its availability for subsequent turns in the session.

### FR-13: Reliable document write-back

- `document_read` must return the complete document to the model when the file fits its bounded read budget and must explicitly report whether the result is complete.
- The persisted timeline records document path, size, and completeness metadata, not the full document body.
- A whole-document rewrite must use `document_write` with the full updated content.
- `apply_patch` is reserved for small localized changes whose exact previous text is available from a complete recent read.
- If `apply_patch` or another workspace write tool fails, the tool loop must provide the failure to the model and require recovery through a reread, a smaller exact patch, or `document_write`.
- A model turn with no content and no tool calls after an unresolved write failure must fail the task.
- The runtime must emit `task.failed`, not `task.completed`, when the requested write remains unresolved.

### FR-14: Table-plan relevance

- A table-plan event may be generated only from an explicit `table_plan` block or table/browser-ingestion tools that contribute table schema, record-draft, or record-write evidence.
- Document reads, image generation, local-source retrieval, filesystem operations, and document patches must not create an empty or zero-count table plan.

## 7. Public contract

The attachment payload is defined by `contracts/runtime/agent-local-sources.schema.json`.

The runtime advertises local source support with `surfaces.local_source_access`. The authoritative tool set for a turn is reported through the turn-capabilities event. Local source tools are omitted when no source is attached, and Git tools are omitted when none of the attached sources supports Git history.

## 8. Safety requirements

- Reject absolute child paths and `..` traversal.
- Resolve paths and prevent symlink escape.
- Exclude `.env` variants, private keys, certificates, and similar credential material.
- Do not follow symlinks during recursive discovery.
- Bound file size, candidate count, searched bytes, result count, context lines, read lines, Git lines, command time, and command output.
- Do not execute repository hooks, external diff commands, pagers, arbitrary commands, or user-provided Git flags.
- Do not persist model-visible source contents in Kition history.

## 9. Performance requirements

- Path discovery must remain interactive for typical repositories without building a persistent index.
- Content search must enforce a bounded candidate set and byte budget.
- Reads must be incremental so a long file does not need to enter model context in full.
- Tool output must explicitly report truncation or budget exhaustion so the Agent can refine the next request.

## 10. Acceptance scenarios

1. Generate an architecture document from a large repository and cite the relevant entry points, modules, configuration, and tests.
2. Trace an API from route declaration through implementation and tests using path search, content search, and line-range reads.
3. Compare current behavior with an earlier Git revision without modifying the repository.
4. Generate release material from code, documentation, and recent commit history.
5. Analyze multiple attached folders while writing only to the current Kition workspace.
6. Search successfully with mixed natural-language keywords, exact symbol names, and path fragments.
7. Complete analysis of a long file through multiple bounded reads without overflowing Agent context.
8. Honor `.gitignore` and explicit include or exclude filters.
9. Apply root and nested project instructions to the files in their scope.
10. Reject credential files, path traversal, symlink escape, invalid revisions, Git option injection, and oversized requests.
11. Confirm that local content appears in active model evidence but not in persisted tool-call output or timeline events.
12. Reproduce `document_read → image_generation → apply_patch failure → empty model turn` and confirm that the task fails without emitting a table plan or successful completion.
13. Reproduce a failed `apply_patch` followed by `document_write` and confirm that the document is updated and the task can complete.

## 11. Success metrics

- Recall of task-relevant evidence files.
- Number of irrelevant file reads per completed task.
- Tool turns required to complete a representative task.
- Factual error rate in generated documents.
- Percentage of important claims traceable to a virtual path and line number.
- First retrieval latency and total task duration.
- Rate of candidate, byte, read, and Git output budget exhaustion.
- Privacy and path-boundary regression rate.
- Unresolved workspace-write completion rate.
- False table-plan event rate on non-table tasks.

## 12. Future considerations

If measured acceptance scenarios still show inadequate lexical ranking after the implemented workflow is tuned, Kition may evaluate a lightweight in-memory lexical ranker with separate weights for path, filename, symbol-like text, headings, and body content.

Any such experiment must remain optional and must not require embeddings, a vector database, a persistent full-folder index, or an external indexing service.

## 13. Implementation map

Public client and contract ownership:

- `contracts/runtime/agent-local-sources.schema.json`
- `src/api/agent.ts`
- Agent UI and session-state modules under `src/features/agent/`.
- `src/features/workspace/components/WorkspaceScreen.tsx`
- Desktop consent and IPC modules under `electron/`.

Private runtime ownership:

- Local-source runtime modules under `api/app/agent/`.
- `api/app/agent/runtime_tools.go`
- `api/app/agent/tool_loop.go`
- `api/app/agent/table_plan.go`

The client repository contains only the public contract, desktop consent flow, UI, mocks, and black-box behavior. Runtime implementation details remain in the private runtime repository.

## 14. Verification

Runtime verification:

```bash
cd <runtime-repo>
GOTOOLCHAIN=auto make verify
```

Client verification:

```bash
cd <client-repo>
python3 scripts/check-i18n.py
pnpm run build:check
pnpm test:table:e2e
```
