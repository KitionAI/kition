# Selection Translation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select text in a document, click Translate in the selection toolbar, see the translation next to the selection, and replace, insert, or copy it. The target language has a default the user can change from the toolbar or in Settings.

**Tech Stack:** TypeScript, React, CodeMirror 6, Vitest, Playwright.

---

## 1. Current state

- The selection toolbar (`src/features/document/components/DocumentAgentSelectionToolbar.tsx`) has four actions: Ask AI, Improve, Shorten, Expand.
- None of them edits the document directly. `useDocumentAgentActions` turns the action into a prompt, writes it into the Agent chat composer, and opens the chat. The user must press send, then copy the answer back.
- The runtime exposes a one-shot, non-streaming completion: `POST /api/v1/ai/chat`, guarded by `RequireAILogin`, accepting `messages` and `runtime_model`. The client wrapper `chatWithModel` in `src/api/models.ts` exists but its `ChatRequest` type omits `runtime_model`.
- Settings already hold `general.language` (the app UI locale), in six locales: en-US, zh-CN, es-ES, fr-FR, pt-BR, ru-RU.

**Decision:** translation does not go through the Agent chat. A chat round trip is the wrong shape for "replace this sentence with its translation". It uses the one-shot endpoint and shows the result inline. The existing four actions stay as they are.

---

## 2. Interaction design

### 2.1 Toolbar

A fifth control, placed after Expand, as a split button:

```
[ ✦ Ask AI… ] [ Improve ] [ Shorten ] [ Expand ] | [ (Languages icon) Translate ▾ ]
```

- **Main part** (Languages icon plus `Translate`): translates immediately into the default target language. Its tooltip names the target: "Translate to English".
- **Chevron** (`▾`): opens a small menu:

```
  Translate to
  ✓ English             (default)
    <Simplified Chinese endonym>
    <Japanese endonym>
    Español
    …
  ───────────────
  ☐ Always use this language
```

  Picking a language translates into it once. Ticking "Always use this language" also makes it the default, so the main button and its tooltip change.
- Languages appear in their own names (endonyms), like the existing locale picker.

### 2.2 Default target language

Resolution order:

1. The language the user set as default (toolbar checkbox or Settings).
2. Otherwise the app UI language.
3. If the selection is already in the target language, fall back to the app's secondary pair: Chinese when the target is English, English otherwise. The check is a cheap script heuristic (share of CJK, Cyrillic, or Latin letters), not a model call. The tooltip then says what will actually happen, for example "Translate to" followed by the Chinese endonym.

Settings gains **General → Translation target language** with "Follow app language" as the first option. The toolbar checkbox and this setting write the same value.

### 2.3 Result card

Clicking Translate opens a card anchored under the selection. It is a popover, not a modal: the document stays scrollable and the selection stays highlighted.

```
┌───────────────────────────────────────────────────┐
│ English → <target endonym> ▾                 ✕    │
│                                                   │
│ <translated text>                                 │
│                                                   │
│ [ Replace ]  [ Insert below ]  [ Copy ]    ↻     │
└───────────────────────────────────────────────────┘
```

- **While loading:** a skeleton of three text lines and a Cancel button. Cancel aborts the request.
- **Replace** (primary, purple): swaps the selected text for the translation in one transaction labeled `input.translate`, so one Cmd+Z restores the original. The card closes.
- **Insert below:** adds the translation as a new paragraph after the block containing the selection, keeping the original. This is the bilingual workflow.
- **Copy:** copies the translation and shows a toast.
- **↻ Retry:** asks again. Useful when the first result is poor.
- **Language chip** (`English → <target> ▾`): changes the target and re-translates without closing the card.
- **Keyboard:** Enter = Replace, Cmd+Enter = Insert below, Cmd+C (when the selection is inside the card) = Copy, Esc = close.
- **Stale selection:** if the user edits the selected range while the request runs, Replace is disabled with the hint "The text changed. Retry to translate the new text." Edits elsewhere in the document are mapped through the transaction, so Replace still hits the right range.

### 2.4 Formatting rules

The translation must drop back into Markdown cleanly:

- Keep Markdown syntax unchanged: emphasis markers, list bullets, heading hashes, links (translate the link text, keep the URL), inline code, code blocks, wikilinks, image embeds.
- Do not translate code, URLs, file paths, or `[[wikilink]]` targets.
- Return only the translation: no preamble, no quotes, no surrounding code fence. The client strips a stray fence or quotes defensively.
- A selection above the length limit (6,000 characters, the same as the other actions) shows "Select less text to translate" instead of sending.

### 2.5 Other entry points

- Editor context menu: **Translate selection** and **Translate selection to…** under the existing AI group.
- Command palette: **Translate selection**.
- Shortcut: Cmd/Ctrl+Shift+Y opens the card with the default target. (Chosen to avoid existing bindings; confirm against the shortcut registry once Task 1.7 of the quality plan lands.)

### 2.6 Errors

- **No model configured:** the card shows "Choose a model to translate" with a **Configure model** button that opens Settings → Models. Same wording and route as the Agent panel.
- **Hosted account not connected or out of credits:** reuse the existing account prompt and the credits-exhausted banner.
- **Request failed:** inline error inside the card with Retry. No toast storm.

---

## 3. Architecture

The document feature must not depend on the Agent feature. The workspace passes a translation function down, the same way it passes `onAskAgent` today.

```
WorkspaceScreen
  └─ useSelectionTranslator(agentModel)  →  translate(text, target, signal): Promise<string>
       └─ chatWithModel({ messages, runtime_model })   POST /v1/ai/chat
WorkspaceEditorContent → DocumentMarkdownEditorPane (prop: translateText)
  ├─ DocumentAgentSelectionToolbar  (Translate split button)
  └─ DocumentTranslationCard        (popover, positioned with view.coordsAtPos)
       └─ useDocumentTranslation    (request state, abort, stale-range guard, apply)
```

| Unit | Responsibility |
| --- | --- |
| `src/features/document/lib/documentTranslation.ts` | Pure: language list with endonyms, script detection, target resolution, prompt builder, result cleaning. |
| `src/features/document/hooks/useDocumentTranslation.ts` | Request lifecycle for one card: loading, result, error, abort, retry, target change; maps the selected range through document changes; applies Replace and Insert below. |
| `src/features/document/components/DocumentTranslationCard.tsx` | The popover UI. Only presentational state. |
| `src/features/workspace/hooks/useSelectionTranslator.ts` | Binds the Agent's selected model to a `translate` function; reports "no model" as a typed error. |
| `src/api/models.ts` | `chatWithModel` gains `runtime_model` and an `AbortSignal`. |
| Settings | `general.translationTargetLanguage: Locale \| 'auto'`, default `'auto'`. |

---

## 4. Tasks

### Task 1: Contract and API

**Files:** `contracts/runtime/ai-chat.schema.json` (new), `src/api/generated/*` (regenerated), `src/api/models.ts`, `src/types/index.ts`

- [ ] Write the public contract for the existing `POST /v1/ai/chat` request and response, including `runtime_model`. Regenerate types and alias `ChatRequest` / `ChatResponse` to them.
- [ ] Let `chatWithModel` take `{ signal }` and pass it to the request so a closed card cancels the call.
- [ ] Spec: the request body matches the contract (`expectMatchesContract`).
- [ ] Mirror the schema into `KitionAI/kition-runtime` `contracts/runtime/`. No runtime code change is needed; the endpoint already accepts these fields.

### Task 2: Pure translation logic

**Files:** `src/features/document/lib/documentTranslation.ts`, `.spec.ts`

- [ ] Language list: the six app locales plus Japanese, Korean, German, Italian, Traditional Chinese, Arabic. Each with an endonym.
- [ ] `detectScript(text)` and `resolveTranslationTarget({ preferred, appLocale, text })` with the fallback in section 2.2.
- [ ] `buildTranslationMessages(text, target)` with the rules in section 2.4.
- [ ] `cleanTranslationResult(raw)` strips a wrapping code fence or quotes and trims.
- [ ] Table-driven specs for each function, including Markdown-heavy input (list, link, inline code, wikilink).

### Task 3: Settings

**Files:** `src/types/desktopSettings.ts`, `src/services/desktopSettings.ts`, the General settings pane, all six `settings.json` locales

- [ ] Add `translationTargetLanguage` with default `'auto'` and a load-time migration for existing settings.
- [ ] Add the select to General with "Follow app language" first.

### Task 4: Translator binding

**Files:** `src/features/workspace/hooks/useSelectionTranslator.ts`, `.spec.ts`, `WorkspaceScreen.tsx`, `WorkspaceEditorContent.tsx`

- [ ] Build `translate(text, target, signal)` from the Agent's selected model (`selectedAgentModel.runtimeModel`). Throw a typed `TranslationModelMissingError` when there is none.
- [ ] Pass it to `DocumentMarkdownEditorPane` as `translateText`. The toolbar hides Translate when the prop is absent (web preview).

### Task 5: Card and hook

**Files:** `useDocumentTranslation.ts`, `DocumentTranslationCard.tsx`, their specs, `document.json` in all six locales

- [ ] Hook states: `idle → loading → ready | error`, with abort on close, retry, and target change.
- [ ] Track the source range with a CodeMirror `StateField` that maps through changes; mark it stale when a change touches it.
- [ ] Replace: one dispatch, `userEvent: 'input.translate'`, selection placed after the inserted text.
- [ ] Insert below: after the end of the block containing the selection, separated by a blank line.
- [ ] Card built from the shared UI kit: 12px card radius, 8px buttons, Replace in the primary purple, focus trapped inside, Esc closes and returns focus to the editor.
- [ ] Component specs: each action, keyboard shortcuts, stale state, error with Configure model.

### Task 6: Entry points

**Files:** `DocumentAgentSelectionToolbar.tsx`, `buildEditorContextMenu.ts`, `DocumentMarkdownEditorPane.tsx` (palette commands)

- [ ] Split button with the language menu and the "Always use this language" checkbox wired to settings.
- [ ] Context menu items, palette command, and the shortcut.

### Task 7: End-to-end

**Files:** `e2e/document-selection-translation.spec.ts`

- [ ] Mock `/api/v1/ai/chat` with Playwright routing. Select a sentence, click Translate, see the card, click Replace, verify the file content, press Cmd+Z, verify the original is back.
- [ ] Pick another language from the chevron with "Always use this language" ticked; reload; the tooltip names the new default.
- [ ] No model configured shows the Configure model state.
- [ ] Verify layout and focus once in the Electron client on macOS; attach screenshots in the commit.

---

## 5. Decisions to confirm

Defaults are chosen so work can start; change any of them before Task 5.

| Question | Default in this plan |
| --- | --- |
| Where the result appears | Inline card with Replace; the original is never changed without a click. |
| Which model translates | The model currently selected in the Agent panel. |
| Hosted model credits | Translation consumes credits like any other AI call; no separate allowance. |
| Whole-document translation | Out of scope here. A later "Translate document to a new file" can reuse the same logic in chunks. |

## 6. Estimate

About two working sessions: Tasks 1 to 4 in the first, Tasks 5 to 7 in the second.
