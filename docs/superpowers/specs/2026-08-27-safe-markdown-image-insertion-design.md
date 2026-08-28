# Safe Markdown Image Insertion Design

## Goal

Keep images generated from the workspace Agent renderable by placing their Markdown image links at a safe block boundary near the active editor cursor.

## Scope

The public client computes and forwards a preferred insertion anchor. It does not implement or recreate private runtime document mutation. The private runtime remains responsible for reading the latest document and applying the final write through public document-tool behavior.

## Insertion Policy

1. Prefer the cursor when it is on a top-level blank line.
2. Otherwise prefer the nearest top-level blank line, choosing the following line when distances are equal.
3. Do not place a block image inside fenced code, inline code, blockquotes, lists, tables, frontmatter, HTML blocks, or other nested Markdown blocks.
4. When no safe blank line exists, choose the boundary after the containing top-level block and request blank-line separation.
5. When parsing or cursor context is unavailable, fall back to the document end with blank-line separation.

## Architecture

`src/features/document/editor/editor/markdown-image-insertion.ts` owns Markdown parsing and safe-anchor selection. It returns a serializable context containing the document path, cursor offset, preferred offset and line, strategy, and nearby text anchors.

`DocumentMarkdownEditorPane` publishes the latest context to workspace composition. `WorkspaceScreen` keeps it in a ref keyed by document path and adds it to `AgentTurnContext` only when it matches the active document. `buildAgentDocumentEditingPromptContext` serializes the context into explicit runtime guidance, including the fallback sequence and a requirement to re-read the document before applying an image link.

## Staleness And Fallback

Offsets are advisory because the document may change after the Agent turn starts. The prompt includes small before/after anchors so the runtime can relocate the boundary after re-reading. If the anchors no longer match, the runtime must select a top-level blank line near the requested line; if none exists, it must append after the current top-level block or at document end.

## Testing

Unit tests exercise the real Markdown parser and literal expected offsets for blank lines, fenced code, inline code, blockquotes, lists, tables, frontmatter, and documents without blank lines. Agent tests verify that the computed context reaches the streamed request and that mismatched or missing context uses the documented fallback rather than stale cursor data.

No real AI or private runtime is required for these tests.
