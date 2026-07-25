   
                                                        
  
                                       
                         
                                                       
                                                     
                                          
                            
                                              
  
       
                                                        
                                                        
                                                   
  
                                                              
                                                                 
  
                                                                    
                                                  
   

import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from '@codemirror/view'
import i18next from 'i18next'

import { parseFrontmatter, type FrontmatterField } from '../../lib/frontmatter-parser'
import { applyFrontmatter, fieldsFromParsed, type EditableField } from '../../lib/frontmatter-serialize'

type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'list'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/
const NUMBER_RE = /^-?\d+(\.\d+)?$/

function inferFieldType(value: string | string[]): FieldType {
  if (Array.isArray(value)) return 'list'
  const t = value.trim()
  if (t === 'true' || t === 'false') return 'checkbox'
  if (DATETIME_RE.test(t)) return 'datetime'
  if (DATE_RE.test(t)) return 'date'
  if (NUMBER_RE.test(t)) return 'number'
  return 'text'
}

function iconGlyphFor(type: FieldType): string {
  switch (type) {
    case 'number': return '#'
    case 'date': return '📅'
    case 'datetime': return '🕒'
    case 'checkbox': return '☑'
    case 'list': return '☰'
    case 'text':
    default: return '≡'
  }
}

                               
const setFrontmatterRawMode = StateEffect.define<'toggle' | boolean>()

const frontmatterRawModeField = StateField.define<boolean>({
  create() { return false },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFrontmatterRawMode)) {
        value = e.value === 'toggle' ? !value : e.value
      }
    }
    return value
  },
})

function toggleFrontmatterRawMode(view: EditorView): boolean {
  view.dispatch({ effects: setFrontmatterRawMode.of('toggle') })
  return true
}

                               
type EditingSlot =
  | null
  | { kind: 'value'; key: string }
  | { kind: 'key'; key: string }
  | { kind: 'array-add'; key: string }
  | { kind: 'new-property' }

const setEditing = StateEffect.define<EditingSlot>()

const editingField = StateField.define<EditingSlot>({
  create() { return null },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setEditing)) value = e.value
    }
                              
    if (tr.docChanged && !tr.effects.some((e) => e.is(setEditing))) {
      value = null
    }
    return value
  },
})

                                                   
function commitFields(view: EditorView, mutate: (fields: EditableField[]) => EditableField[] | null, nextEditing: EditingSlot = null): void {
  const doc = view.state.doc
  const source = doc.toString()
  const parsed = parseFrontmatter(source)
  if (!parsed) return
  const fields = mutate(fieldsFromParsed(parsed.fields))
  if (!fields) return
  const newSource = applyFrontmatter(source, fields, parsed)
                                              
  let end = parsed.to
  if (source[end] === '\n') end += 1
  const inserted = newSource.slice(0, newSource.length - (source.length - end))
  view.dispatch({
    changes: { from: 0, to: end, insert: inserted },
    effects: setEditing.of(nextEditing),
  })
}

class FrontmatterPropertiesWidget extends WidgetType {
  constructor(
    readonly fields: FrontmatterField[],
    readonly editing: EditingSlot,
  ) {
    super()
  }

  eq(other: FrontmatterPropertiesWidget): boolean {
    if (!editingSlotEq(this.editing, other.editing)) return false
    if (other.fields.length !== this.fields.length) return false
    for (let i = 0; i < this.fields.length; i++) {
      const a = this.fields[i]
      const b = other.fields[i]
      if (a.key !== b.key) return false
      if (Array.isArray(a.value) !== Array.isArray(b.value)) return false
      if (Array.isArray(a.value) && Array.isArray(b.value)) {
        if (a.value.length !== b.value.length) return false
        for (let j = 0; j < a.value.length; j++) if (a.value[j] !== b.value[j]) return false
      } else if (a.value !== b.value) {
        return false
      }
    }
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const t = i18next.getFixedT(null, 'document')
    const root = document.createElement('div')
    root.className = 'cm-document-properties'

    for (const field of this.fields) {
      root.appendChild(this.renderRow(view, field, t))
    }

                
    root.appendChild(this.renderAddProperty(view, t))

                                                
    requestAnimationFrame(() => {
      const focusEl = root.querySelector<HTMLInputElement>('[data-cm-frontmatter-focus="1"]')
      if (focusEl) {
        focusEl.focus()
        if (focusEl.value) focusEl.select()
      }
    })

    return root
  }

  ignoreEvent(): boolean {
                                                  
    return true
  }

  private renderRow(view: EditorView, field: FrontmatterField, t: ReturnType<typeof i18next.getFixedT>): HTMLElement {
    const type = inferFieldType(field.value)
    const row = document.createElement('div')
    row.className = 'cm-document-properties__row'
    row.dataset.type = type

                             
    const icon = document.createElement('span')
    icon.className = 'cm-document-properties__icon'
    icon.textContent = iconGlyphFor(type)
    icon.title = t('editor.extensions.frontmatter.toggleRaw')
    icon.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toggleFrontmatterRawMode(view)
    })
    row.appendChild(icon)

        
    if (this.editing && this.editing.kind === 'key' && this.editing.key === field.key) {
      row.appendChild(this.renderKeyInput(view, field, t))
    } else {
      const key = document.createElement('span')
      key.className = 'cm-document-properties__key'
      key.textContent = field.key
      key.title = t('editor.extensions.frontmatter.clickToRenameKey')
      key.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch({ effects: setEditing.of({ kind: 'key', key: field.key }) })
      })
      row.appendChild(key)
    }

        
    row.appendChild(this.renderValue(view, field, type, t))

    return row
  }

  private renderKeyInput(view: EditorView, field: FrontmatterField, t: ReturnType<typeof i18next.getFixedT>): HTMLElement {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'cm-document-properties__input cm-document-properties__input--key'
    input.value = field.key
    input.placeholder = t('editor.extensions.frontmatter.keyPlaceholder')
    input.dataset.cmFrontmatterFocus = '1'

    const commit = (cancel: boolean) => {
      if (cancel) {
        view.dispatch({ effects: setEditing.of(null) })
        return
      }
      const next = input.value.trim()
      if (!next || next === field.key) {
        view.dispatch({ effects: setEditing.of(null) })
        return
      }
      commitFields(view, (fields) => {
        const collision = fields.some((f) => f.key === next)
        if (collision) return null
        return fields.map((f) => (f.key === field.key ? { ...f, key: next } : f))
      })
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(false) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(true) }
    })
    input.addEventListener('blur', () => commit(false))
    return input
  }

  private renderValue(view: EditorView, field: FrontmatterField, type: FieldType, t: ReturnType<typeof i18next.getFixedT>): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'cm-document-properties__value'

    if (type === 'checkbox') {
      const box = document.createElement('button')
      box.type = 'button'
      box.className = 'cm-document-properties__checkbox'
      box.textContent = (field.value as string).trim() === 'true' ? '☑' : '☐'
      box.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const next = (field.value as string).trim() === 'true' ? 'false' : 'true'
        commitFields(view, (fields) =>
          fields.map((f) => (f.key === field.key ? { ...f, value: next } : f)),
        )
      })
      cell.appendChild(box)
      return cell
    }

    if (Array.isArray(field.value)) {
      // chips
      field.value.forEach((item, idx) => {
        const chip = document.createElement('span')
        chip.className = 'cm-document-properties__chip'
        const txt = document.createElement('span')
        txt.textContent = item
        chip.appendChild(txt)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'cm-document-properties__chip-remove'
        remove.textContent = '×'
        remove.title = t('editor.extensions.frontmatter.removeChip')
        remove.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          commitFields(view, (fields) =>
            fields.map((f) => {
              if (f.key !== field.key || !Array.isArray(f.value)) return f
              const next = f.value.slice()
              next.splice(idx, 1)
              return { ...f, value: next }
            }),
          )
        })
        chip.appendChild(remove)
        cell.appendChild(chip)
      })
                   
      if (this.editing && this.editing.kind === 'array-add' && this.editing.key === field.key) {
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'cm-document-properties__input cm-document-properties__input--chip'
        input.placeholder = t('editor.extensions.frontmatter.chipPlaceholder')
        input.dataset.cmFrontmatterFocus = '1'
        const commit = (cancel: boolean) => {
          if (cancel) {
            view.dispatch({ effects: setEditing.of(null) })
            return
          }
          const v = input.value.trim()
          if (!v) {
            view.dispatch({ effects: setEditing.of(null) })
            return
          }
                                    
          commitFields(
            view,
            (fields) => fields.map((f) => {
              if (f.key !== field.key) return f
              const cur = Array.isArray(f.value) ? f.value.slice() : []
              cur.push(v)
              return { ...f, value: cur }
            }),
            { kind: 'array-add', key: field.key },
          )
        }
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(false) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(true) }
        })
        input.addEventListener('blur', () => commit(false))
        cell.appendChild(input)
      } else {
        const addBtn = document.createElement('button')
        addBtn.type = 'button'
        addBtn.className = 'cm-document-properties__chip-add'
        addBtn.textContent = '+'
        addBtn.title = t('editor.extensions.frontmatter.addChip')
        addBtn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          view.dispatch({ effects: setEditing.of({ kind: 'array-add', key: field.key }) })
        })
        cell.appendChild(addBtn)
      }
      return cell
    }

         
    if (this.editing && this.editing.kind === 'value' && this.editing.key === field.key) {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'cm-document-properties__input cm-document-properties__input--value'
      input.value = field.value as string
      input.placeholder = t('editor.extensions.frontmatter.valuePlaceholder')
      input.dataset.cmFrontmatterFocus = '1'
      const commit = (cancel: boolean) => {
        if (cancel) {
          view.dispatch({ effects: setEditing.of(null) })
          return
        }
        const next = input.value
        if (next === field.value) {
          view.dispatch({ effects: setEditing.of(null) })
          return
        }
        commitFields(view, (fields) =>
          fields.map((f) => (f.key === field.key ? { ...f, value: next } : f)),
        )
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(false) }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(true) }
      })
      input.addEventListener('blur', () => commit(false))
      cell.appendChild(input)
    } else {
      const text = (field.value as string).trim()
      const span = document.createElement('span')
      span.className = 'cm-document-properties__value-text'
      if (text === '') {
        span.textContent = t('editor.extensions.frontmatter.emptyValue')
        span.classList.add('cm-document-properties__value--muted')
      } else {
        span.textContent = field.value as string
      }
      span.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch({ effects: setEditing.of({ kind: 'value', key: field.key }) })
      })
      cell.appendChild(span)
    }
    return cell
  }

  private renderAddProperty(view: EditorView, t: ReturnType<typeof i18next.getFixedT>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cm-document-properties__add-row'
    if (this.editing && this.editing.kind === 'new-property') {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'cm-document-properties__input cm-document-properties__input--new-key'
      input.placeholder = t('editor.extensions.frontmatter.newKeyPlaceholder')
      input.dataset.cmFrontmatterFocus = '1'
      const commit = (cancel: boolean) => {
        if (cancel) {
          view.dispatch({ effects: setEditing.of(null) })
          return
        }
        const key = input.value.trim()
        if (!key) {
          view.dispatch({ effects: setEditing.of(null) })
          return
        }
        commitFields(
          view,
          (fields) => {
            if (fields.some((f) => f.key === key)) return null
            return [...fields, { key, value: '' }]
          },
          { kind: 'value', key },
        )
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(false) }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(true) }
      })
      input.addEventListener('blur', () => commit(false))
      row.appendChild(input)
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cm-document-properties__add-btn'
      btn.textContent = '+ ' + t('editor.extensions.frontmatter.addProperty')
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch({ effects: setEditing.of({ kind: 'new-property' }) })
      })
      row.appendChild(btn)
    }
    return row
  }
}

function editingSlotEq(a: EditingSlot, b: EditingSlot): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'new-property' && b.kind === 'new-property') return true
  return 'key' in a && 'key' in b && a.key === b.key
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (state.field(frontmatterRawModeField, false) === true) return builder.finish()

  const doc = state.doc
  const source = doc.sliceString(0, Math.min(doc.length, 4000))
  const parsed = parseFrontmatter(source)
  if (!parsed) return builder.finish()

  const startLineFrom = doc.lineAt(parsed.from).from
  const editing = state.field(editingField, false) ?? null
  const widget = new FrontmatterPropertiesWidget(parsed.fields, editing)
  builder.add(
    startLineFrom,
    parsed.to,
    Decoration.replace({
      widget,
      block: true,
    }),
  )
  return builder.finish()
}

                                                                     
                                                            
const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state)
  },
  update(value, tr) {
    let needRebuild = tr.docChanged
    if (!needRebuild) {
      for (const e of tr.effects) {
        if (e.is(setFrontmatterRawMode) || e.is(setEditing)) {
          needRebuild = true
          break
        }
      }
    }
    if (!needRebuild) return value
    return buildFrontmatterDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

export function frontmatterWidgetExtension(): Extension {
  return [
    frontmatterRawModeField,
    editingField,
    frontmatterField,
    Prec.high(
      keymap.of([
        { key: 'Mod-Shift-y', run: toggleFrontmatterRawMode, preventDefault: true },
      ]),
    ),
    frontmatterTheme,
  ]
}

const frontmatterTheme = EditorView.theme({
  '.cm-document-properties': {
    display: 'block',
    margin: '0 0 1rem 0',
    paddingBlock: '0.25rem',
    fontFamily: 'inherit',
    fontSize: '0.95em',
    lineHeight: '1.6',
  },
  '.cm-document-properties__row': {
    display: 'grid',
    gridTemplateColumns: '1.5rem minmax(8rem, max-content) 1fr',
    alignItems: 'center',
    columnGap: '0.5rem',
    padding: '0.18rem 0.4rem',
    borderRadius: '6px',
  },
  '.cm-document-properties__row:hover': {
    background: 'hsl(var(--accent) / 0.18)',
  },
  '.cm-document-properties__icon': {
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.95em',
    cursor: 'default',
    userSelect: 'none',
    textAlign: 'center',
  },
  '.cm-document-properties__key': {
    color: 'hsl(var(--muted-foreground))',
    fontWeight: '400',
    cursor: 'text',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-document-properties__value': {
    color: 'hsl(var(--foreground))',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.25rem 0.4rem',
    cursor: 'text',
    minWidth: '0',
    overflowWrap: 'anywhere',
  },
  '.cm-document-properties__value-text': {
    cursor: 'text',
    flex: '1 1 auto',
    minWidth: '0',
  },
  '.cm-document-properties__value--muted': {
    color: 'hsl(var(--muted-foreground))',
    fontStyle: 'italic',
  },
  '.cm-document-properties__chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.2rem',
    padding: '0.05rem 0.15rem 0.05rem 0.5rem',
    borderRadius: '999px',
    background: 'hsl(var(--accent) / 0.35)',
    color: 'hsl(var(--foreground))',
    fontSize: '0.92em',
    lineHeight: '1.4',
  },
  '.cm-document-properties__chip-remove': {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    padding: '0 0.25rem',
    color: 'hsl(var(--muted-foreground))',
    cursor: 'pointer',
    fontSize: '0.95em',
    lineHeight: '1',
    opacity: '0.6',
  },
  '.cm-document-properties__chip-remove:hover': {
    color: 'hsl(var(--foreground))',
    opacity: '1',
  },
  '.cm-document-properties__chip-add': {
    appearance: 'none',
    background: 'transparent',
    border: '1px dashed hsl(var(--border))',
    borderRadius: '999px',
    padding: '0.05rem 0.6rem',
    color: 'hsl(var(--muted-foreground))',
    cursor: 'pointer',
    fontSize: '0.92em',
    lineHeight: '1.4',
  },
  '.cm-document-properties__chip-add:hover': {
    color: 'hsl(var(--foreground))',
    borderColor: 'hsl(var(--border) / 1)',
    background: 'hsl(var(--accent) / 0.2)',
  },
  '.cm-document-properties__checkbox': {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    padding: '0',
    color: 'hsl(var(--foreground))',
    cursor: 'pointer',
    fontSize: '1.05em',
    lineHeight: '1',
  },
  '.cm-document-properties__input': {
    boxSizing: 'border-box',
    width: '100%',
    background: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    border: '1px solid hsl(var(--ring) / 0.55)',
    borderRadius: '6px',
    padding: '0.1rem 0.4rem',
    fontFamily: 'inherit',
    fontSize: '1em',
    lineHeight: '1.4',
    outline: 'none',
    boxShadow: '0 0 0 1px hsl(var(--ring) / 0.15)',
  },
  '.cm-document-properties__input:focus': {
    borderColor: 'hsl(var(--ring))',
    boxShadow: '0 0 0 2px hsl(var(--ring) / 0.25)',
  },
  '.cm-document-properties__input--key': {
    minWidth: '6rem',
  },
  '.cm-document-properties__input--chip': {
    width: 'auto',
    minWidth: '6rem',
    maxWidth: '12rem',
  },
  '.cm-document-properties__input--new-key': {
    minWidth: '10rem',
    maxWidth: '18rem',
  },
  '.cm-document-properties__add-row': {
    padding: '0.35rem 0.4rem',
    marginTop: '0.15rem',
  },
  '.cm-document-properties__add-btn': {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    padding: '0.1rem 0.2rem',
    color: 'hsl(var(--muted-foreground))',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.92em',
  },
  '.cm-document-properties__add-btn:hover': {
    color: 'hsl(var(--foreground))',
  },
})
