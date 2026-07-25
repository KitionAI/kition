import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'
import { fieldTypeIcon, fieldTypeLabel } from '@/features/workflow/lib/fieldTypeIcon'
import type { BodyPart, BodyTemplate, FieldSchema, TableSchema } from './BodyTemplateEditor.types'
import { cn } from '@/lib/utils'

export interface TemplateTokenInputProps {
  /** Current template value. Always a BodyTemplate (parts array) so subject
   *  and body share the same shape. */
  value: BodyTemplate
  onChange: (next: BodyTemplate) => void
  /** Bound table schema. Drives the field picker and the chip label
   *  resolution. A field_ref whose id isn't in `schema.fields` renders as
   *  a red "missing" chip so the user can spot+remove it. */
  schema: TableSchema | null
  /** Trigger nodeId stored on each inserted field_ref. */
  triggerNodeId?: string
  triggerNodeTitle?: string
  /** When true, Enter inserts a newline and the picker exposes the ↵
   *  insert-newline option. Single-line mode (subject) suppresses both. */
  multiline?: boolean
  placeholder?: string
  testId?: string
  disabled?: boolean
}

/**
 * TemplateTokenInput is an inline rich-text editor for the email Action's
 * subject + body. The data model stays the BodyTemplate from before
 * (`{parts:[{kind:'text'|'field_ref'|'newline'}]}`) so storage and the
 * backend renderer round-trip unchanged.
 *
 * Visually it looks and feels like one editable line of text where:
 *
 *   - plain text flows inline and is freely editable;
 *   - field references render as inline chips, contentEditable=false so
 *     the cursor steps OVER them (a single backspace removes the whole
 *     chip — the browser's standard inline-block delete behaviour);
 *   - the "+" button on the right opens a field picker; clicking a field
 *     drops a new chip at the current caret position so the inserted
 *     token lands wherever the user was typing.
 *
 * Implementation note: we use contentEditable directly (rather than the
 * earlier card-per-part React layout that wrapped chips to new lines)
 * because that's the only way to keep text+chip alignment AND let the
 * browser handle line wrapping the way users expect — see the user
 * report that ended that earlier design. The trade-off is that we own
 * the DOM↔BodyTemplate sync manually; the seed (`useEffect` against
 * `value`) only fires when the *external* value changes, so the user's
 * keystrokes don't churn the DOM and lose the caret.
 */
export function TemplateTokenInput({
  value,
  onChange,
  schema,
  triggerNodeId = 'trigger_1',
  triggerNodeTitle,
  multiline = false,
  placeholder,
  testId,
  disabled,
}: TemplateTokenInputProps) {
  const { t } = useTranslation('workflow')
  const editorRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Track the most recent value we *wrote into* the DOM. When `value`
  // matches this signature we know the change came from our own
  // onInput → onChange round trip and we should NOT touch the DOM —
  // doing so would blow away the caret position mid-typing.
  const lastDomSignatureRef = useRef<string>('')
  const triggerNodeIdRef = useRef(triggerNodeId)
  triggerNodeIdRef.current = triggerNodeId
  const fields = schema?.fields || []
  const fieldById = new Map(fields.map((f) => [f.id, f]))
  const [pickerOpen, setPickerOpen] = useState(false)

  // Re-seed the DOM when the value or the schema changes externally. The
  // schema is in the dependency list because chip labels resolve through
  // it — a late-arriving schema fetch should refresh stale "missing
  // field" chips to their proper names without the user touching the
  // editor.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const sig = stringifyTemplate(value)
    if (sig === lastDomSignatureRef.current) return
    renderTemplateInto(el, value, fieldById, triggerNodeTitle)
    lastDomSignatureRef.current = sig
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fieldById is derived from schema; including it would refresh on every render
  }, [value, schema, triggerNodeTitle])

  function commitFromDom() {
    const el = editorRef.current
    if (!el) return
    const next = parseTemplateFromDom(el, triggerNodeIdRef.current)
    const sig = stringifyTemplate(next)
    // Skip the round-trip when the parse produced something structurally
    // identical — that happens after every keystroke that doesn't add or
    // remove a token, and re-emitting it just churns React state for
    // nothing.
    if (sig === lastDomSignatureRef.current) return
    lastDomSignatureRef.current = sig
    onChangeRef.current(next)
  }

  function handleInput() {
    commitFromDom()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      if (!multiline) {
        event.preventDefault()
        return
      }
      // Default contentEditable Enter inserts a <div>, which makes our
      // parser job harder and stacks unwanted block-level wrappers. Insert
      // a literal <br> at the caret instead so the DOM stays flat.
      event.preventDefault()
      insertNodeAtCaret(document.createElement('br'))
      // After insertNode the caret sits *before* the inserted node in
      // some browsers; advance it so subsequent typing lands on the new
      // line.
      moveCaretAfterLastInserted(editorRef.current)
      commitFromDom()
    }
  }

  function insertField(field: FieldSchema) {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const chip = createChipElement(field, field.id, triggerNodeTitle)
    insertNodeAtCaret(chip)
    moveCaretAfterLastInserted(editor)
    setPickerOpen(false)
    commitFromDom()
  }

  function insertNewline() {
    if (!multiline) return
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    insertNodeAtCaret(document.createElement('br'))
    moveCaretAfterLastInserted(editor)
    setPickerOpen(false)
    commitFromDom()
  }

  const empty = (value.parts || []).every((p) => p.kind === 'text' && !p.text.trim())

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex w-full items-start gap-1 rounded-md border border-border bg-card px-2 py-1.5 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30',
        disabled && 'opacity-60',
        multiline ? 'min-h-24' : '',
      )}
    >
      <div className="relative min-w-0 flex-1">
        {empty && placeholder ? (
          <span className="pointer-events-none absolute left-1 top-0.5 text-sm text-muted-foreground/80">{placeholder}</span>
        ) : null}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          // Bare div + whitespace-pre-wrap + break-words lets the browser
          // do the line-wrapping it would do for a plain paragraph; chips
          // sit inline because they're inline-block and the wrapper has
          // no display:flex on it.
          className="min-h-6 w-full whitespace-pre-wrap break-words rounded bg-transparent px-1 py-0.5 text-sm leading-relaxed text-foreground outline-none"
          role="textbox"
          aria-multiline={multiline}
          data-testid={testId ? `${testId}-editor` : 'template-token-editor'}
        />
      </div>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid={testId ? `${testId}-add` : 'template-token-add'}
            aria-label={t('panels.bodyEditor.insertField')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={disabled || !schema}
          >
            <Plus className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-64 rounded-lg border border-border bg-card p-1 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
        >
          <FieldPickerList
            fields={fields}
            triggerNodeTitle={triggerNodeTitle}
            multiline={multiline}
            onInsertField={insertField}
            onInsertNewline={insertNewline}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

interface FieldPickerListProps {
  fields: FieldSchema[]
  triggerNodeTitle?: string
  multiline: boolean
  onInsertField: (field: FieldSchema) => void
  onInsertNewline: () => void
}

function FieldPickerList({ fields, triggerNodeTitle, multiline, onInsertField, onInsertNewline }: FieldPickerListProps) {
  const { t } = useTranslation('workflow')
  return (
    <div role="listbox" aria-label={t('panels.bodyEditor.insertField')} className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
      {triggerNodeTitle ? (
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {triggerNodeTitle}
        </div>
      ) : null}
      {fields.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground/80">{t('panels.bodyEditor.noFieldsAvailable', { defaultValue: 'No fields available' })}</div>
      ) : (
        fields.map((field) => (
          <button
            key={field.id}
            type="button"
            role="option"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-primary/10 focus:bg-primary/10 focus:outline-none"
            onClick={() => onInsertField(field)}
            data-testid={`template-token-field-${field.id}`}
            title={fieldTypeLabel(field.type)}
          >
            <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
              {fieldTypeIcon(field.type)}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground">{field.name}</span>
          </button>
        ))
      )}
      {multiline ? (
        <>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="option"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs uppercase tracking-wide text-muted-foreground hover:bg-primary/10"
            onClick={onInsertNewline}
            data-testid="template-token-insert-newline"
          >
            ↵ {t('panels.bodyEditor.addNewline')}
          </button>
        </>
      ) : null}
    </div>
  )
}

// ─── DOM ↔ BodyTemplate plumbing ──────────────────────────────────────────

// CHIP_TOKEN_ATTR marks a chip span so parseTemplateFromDom can tell
// "this is a typed token, read its data-field-id" from "this is normal
// text the user pasted". Keeping the attribute name boring (no React
// data-* convention here — we're outside React for the DOM walk) avoids
// collisions with anything else in the editor's subtree.
const CHIP_TOKEN_ATTR = 'data-template-token'
const CHIP_FIELD_ATTR = 'data-template-field-id'

function createChipElement(field: FieldSchema | undefined, fallbackId: string, triggerNodeTitle?: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute(CHIP_TOKEN_ATTR, 'field')
  span.setAttribute(CHIP_FIELD_ATTR, field?.id ?? fallbackId)
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-testid', 'template-token-chip')
  const known = !!field
  const label = field?.name ?? fallbackId
  span.title = known && triggerNodeTitle ? `${triggerNodeTitle} · ${label}` : known ? label : `Missing field ${fallbackId}`
  span.className = [
    'mx-[1px] inline-flex max-w-[12rem] items-center gap-1 rounded border px-1.5 py-0 align-[-1px] text-xs',
    known ? 'border-border bg-primary/10 text-foreground' : 'border-dashed border-destructive bg-destructive/10 text-destructive',
  ].join(' ')
  if (known) {
    const icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    icon.className = 'text-[10px] text-muted-foreground'
    icon.textContent = fieldTypeIcon(field!.type)
    span.appendChild(icon)
  }
  const text = document.createElement('span')
  text.className = 'truncate'
  text.textContent = label
  span.appendChild(text)
  return span
}

function renderTemplateInto(host: HTMLElement, template: BodyTemplate, fieldById: Map<string, FieldSchema>, triggerNodeTitle: string | undefined): void {
  host.innerHTML = ''
  const parts = template.parts || []
  if (parts.length === 0) {
    return
  }
  for (const part of parts) {
    if (part.kind === 'text') {
      host.appendChild(document.createTextNode(part.text ?? ''))
    } else if (part.kind === 'field_ref') {
      const field = fieldById.get(part.fieldRef.fieldId)
      host.appendChild(createChipElement(field, part.fieldRef.fieldId, triggerNodeTitle))
    } else if (part.kind === 'newline') {
      host.appendChild(document.createElement('br'))
    }
  }
}

function parseTemplateFromDom(host: HTMLElement, triggerNodeId: string): BodyTemplate {
  const parts: BodyPart[] = []
  let textBuf = ''
  function flush() {
    if (textBuf) {
      parts.push({ kind: 'text', text: textBuf })
      textBuf = ''
    }
  }
  // Walk only the direct children + descendants flattening text. Most
  // chips are direct children but the browser may wrap pasted content in
  // anonymous spans / divs; treat unknown elements as their textContent
  // so paste doesn't accidentally swallow user input.
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      textBuf += node.textContent ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) {
      return
    }
    if (node.tagName === 'BR') {
      flush()
      parts.push({ kind: 'newline' })
      return
    }
    if (node.getAttribute(CHIP_TOKEN_ATTR) === 'field') {
      const fieldId = node.getAttribute(CHIP_FIELD_ATTR) ?? ''
      if (fieldId) {
        flush()
        parts.push({ kind: 'field_ref', fieldRef: { nodeId: triggerNodeId, fieldId } })
      }
      return
    }
    // Block-level wrappers Chrome inserts on Enter when we forget to
    // preventDefault (defensive — we DO preventDefault now, but the
    // parser stays tolerant): walk children and emit an implicit
    // newline at the boundary.
    if (node.tagName === 'DIV' || node.tagName === 'P') {
      if (textBuf || parts.length > 0) {
        flush()
        parts.push({ kind: 'newline' })
      }
      node.childNodes.forEach(walk)
      return
    }
    node.childNodes.forEach(walk)
  }
  host.childNodes.forEach(walk)
  flush()
  return { parts }
}

function stringifyTemplate(template: BodyTemplate): string {
  return JSON.stringify(template.parts || [])
}

// ─── caret helpers ────────────────────────────────────────────────────────

// We always insert at the current caret instead of appending to the end —
// otherwise picking a field while the user has the caret mid-sentence
// would drop the token at the end, which is jarring. Falls back to "end
// of editor" when there's no selection (e.g. button click before user
// has focused the editor).
function insertNodeAtCaret(node: Node) {
  const selection = window.getSelection()
  if (!selection) return
  let range: Range | null = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  // If the selection is outside our editor (the user clicked + without
  // focusing the editor first), the caller has already called
  // editor.focus() — refresh `range` after that.
  if (range && !document.activeElement?.contains(range.startContainer)) {
    range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  }
  if (range) {
    range.deleteContents()
    range.insertNode(node)
  }
}

function moveCaretAfterLastInserted(editor: HTMLElement | null) {
  if (!editor) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  // Move caret just AFTER the most recently inserted node.
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}
