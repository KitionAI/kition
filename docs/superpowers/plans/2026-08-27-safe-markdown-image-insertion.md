# Safe Markdown Image Insertion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide the workspace Agent with a parser-derived, cursor-aware safe Markdown image insertion anchor and deterministic fallback guidance.

**Architecture:** The document editor computes a serializable insertion context from the real Markdown syntax tree. Workspace composition forwards only matching active-document context, and the Agent prompt tells the private runtime how to relocate stale anchors and fall back safely.

**Tech Stack:** TypeScript, React, CodeMirror 6, Lezer Markdown, Vitest

**Spec:** `docs/superpowers/specs/2026-08-27-safe-markdown-image-insertion-design.md`

## Global Constraints

- Keep all repository source, tests, fixtures, comments, and documentation in English.
- Do not add private runtime implementation to this repository.
- Use parser-derived Markdown structure instead of filename, content, or syntax-case hardcoding.
- Run `python3 scripts/check-i18n.py` and `pnpm test:table:e2e` before completion.

---

### Task 1: Safe Markdown insertion resolver

**Files:**
- Create: `src/features/document/editor/editor/markdown-image-insertion.ts`
- Create: `src/features/document/editor/editor/markdown-image-insertion.spec.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `resolveMarkdownImageInsertionContext(input: { documentPath: string; markdown: string; cursorOffset?: number }): MarkdownImageInsertionContext`
- Produces: `MarkdownImageInsertionContext` with `documentPath`, `cursorOffset`, `preferredOffset`, `preferredLine`, `strategy`, `anchorBefore`, and `anchorAfter`.

- [x] **Step 1: Write failing table-driven tests** covering a top-level blank cursor line, fenced code, inline code, blockquote, list, GFM table, frontmatter, and no-blank-line fallback with literal expected offsets and strategies.

- [x] **Step 2: Run the focused test** with `pnpm vitest run --config tooling/vitest.config.ts src/features/document/editor/editor/markdown-image-insertion.spec.ts` and confirm it fails because the resolver is absent.

- [x] **Step 3: Add the direct `@lezer/markdown` development dependency** and implement the minimal parser-backed resolver. Configure the parser with `GFM`, collect top-level blank-line candidates, avoid nested block nodes, and fall back to the containing top-level block end or document end.

- [x] **Step 4: Run the focused test** and confirm every resolver case passes.

### Task 2: Publish cursor-aware insertion context

**Files:**
- Modify: `src/features/document/components/DocumentMarkdownEditorPane.tsx`
- Modify: `src/features/workspace/components/WorkspaceEditorContent.tsx`
- Modify: `src/features/workspace/components/WorkspaceScreen.tsx`
- Modify: `src/features/agent/lib/agentTurnContext.ts`
- Modify: `src/features/agent/lib/agentTurnContext.spec.ts`

**Interfaces:**
- Consumes: `resolveMarkdownImageInsertionContext` and `MarkdownImageInsertionContext`.
- Produces: `onAgentInsertionContextChange(context)` from the document pane and optional `markdownImageInsertionContext` on `AgentTurnContext`.

- [x] **Step 1: Write failing tests** proving `buildAgentTurnContext` keeps matching cursor context and excludes context for a different document.

- [x] **Step 2: Run the focused test** and confirm the new context assertions fail.

- [x] **Step 3: Implement context propagation** from the mounted CodeMirror editor through workspace composition into `AgentTurnContext`, clearing stale context when the pane unmounts or the active path changes.

- [x] **Step 4: Run the focused context tests** and existing workspace editor tests.

### Task 3: Forward safe placement guidance to the Agent request

**Files:**
- Modify: `src/features/agent/lib/agentDocumentEditing.ts`
- Modify: `src/features/agent/lib/agentDocumentEditing.spec.ts`
- Modify: `src/features/agent/hooks/useWorkspaceAgent.ts`
- Modify: `src/features/agent/hooks/useWorkspaceAgent.spec.ts`

**Interfaces:**
- Consumes: `markdownImageInsertionContext` from `AgentTurnContext`.
- Produces: prompt guidance containing preferred line/offset, nearby anchors, prohibited nested-block insertion, and the ordered fallback policy.

- [x] **Step 1: Write failing behavior tests** that send an Agent message with a real insertion context and assert the streamed request carries the safe placement contract; add a missing-context case that carries the document-end fallback.

- [x] **Step 2: Run the focused Agent tests** and confirm the new expectations fail for the missing guidance.

- [x] **Step 3: Implement minimal prompt serialization** and pass the turn context into `buildAgentDocumentEditingPromptContext` without changing private runtime behavior.

- [x] **Step 4: Run all focused tests** for the resolver, turn context, document editing prompt, and workspace Agent hook.

### Task 4: Verification

**Files:**
- Verify all files modified above.

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: fresh verification evidence.

- [x] **Step 1: Run `python3 scripts/check-i18n.py`.**

- [x] **Step 2: Run `pnpm run build:check`.**

- [x] **Step 3: Run `pnpm test:table:e2e`.**

- [x] **Step 4: Inspect `git diff --check`, `git diff --stat`, and tracked changes for host-identifying paths.**
