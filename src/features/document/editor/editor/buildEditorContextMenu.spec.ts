import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { buildEditorContextMenu } from './buildEditorContextMenu'

function titles(menu: ReturnType<typeof buildEditorContextMenu>) {
  return menu.items.map((e) => (e.kind === 'item' ? e.title : '---'))
}

describe('buildEditorContextMenu', () => {
  it('matches the Document top-level structure', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '' }) })
    const menu = buildEditorContextMenu(view)
    expect(titles(menu)).toEqual([
      'Add link',
      'Add external link',
      '---',
      'Text format',
      'Paragraph',
      'Insert',
      '---',
      'Cut',
      'Copy',
      'Paste',
      'Paste as plain text',
      'Select all',
    ])
  })

  it('text-format submenu contains all formatting items', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '' }) })
    const menu = buildEditorContextMenu(view)
    const tf = menu.items.find((e) => e.kind === 'item' && e.title === 'Text format')
    if (!tf || tf.kind !== 'item' || !tf.submenu) throw new Error('Text format missing')
    expect(tf.submenu.items.map((e) => (e.kind === 'item' ? e.title : '---'))).toEqual([
      'Bold', 'Italic', 'Strikethrough', 'Code', 'Highlight', 'Comment', '---', 'Clear formatting',
    ])
  })

  it('paragraph submenu contains heading levels + lists + quote', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '' }) })
    const menu = buildEditorContextMenu(view)
    const ps = menu.items.find((e) => e.kind === 'item' && e.title === 'Paragraph')
    if (!ps || ps.kind !== 'item' || !ps.submenu) throw new Error('Paragraph missing')
    expect(ps.submenu.items.map((e) => (e.kind === 'item' ? e.title : '---'))).toEqual([
      'Body', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6',
      '---', 'Bullet list', 'Numbered list', 'Task list', 'Quote',
    ])
  })

  it('insert submenu contains block primitives', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '' }) })
    const menu = buildEditorContextMenu(view)
    const ins = menu.items.find((e) => e.kind === 'item' && e.title === 'Insert')
    if (!ins || ins.kind !== 'item' || !ins.submenu) throw new Error('Insert missing')
    expect(ins.submenu.items.map((e) => (e.kind === 'item' ? e.title : '---'))).toEqual([
      'Code block', 'Math block', 'Table', 'Footnote', 'Divider',
    ])
  })
})

describe('buildEditorContextMenu clipboard wiring', () => {
  it('cut/copy disabled when no selection, enabled with selection', () => {
    const empty = new EditorView({ state: EditorState.create({ doc: 'hello' }) })
    const m1 = buildEditorContextMenu(empty)
    const cut1 = m1.items.find((e) => e.kind === 'item' && e.title === 'Cut')
    if (!cut1 || cut1.kind !== 'item') throw new Error('Cut missing')
    expect(cut1.disabled).toBe(true)

    const withSel = new EditorView({
      state: EditorState.create({ doc: 'hello', selection: { anchor: 0, head: 5 } }),
    })
    const m2 = buildEditorContextMenu(withSel)
    const cut2 = m2.items.find((e) => e.kind === 'item' && e.title === 'Cut')
    if (!cut2 || cut2.kind !== 'item') throw new Error('Cut missing')
    expect(cut2.disabled).toBe(false)
  })

  it('copy writes selection to navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText, readText: vi.fn() } })

    const view = new EditorView({
      state: EditorState.create({ doc: 'hello', selection: { anchor: 0, head: 5 } }),
    })
    const menu = buildEditorContextMenu(view)
    const copy = menu.items.find((e) => e.kind === 'item' && e.title === 'Copy')
    if (!copy || copy.kind !== 'item' || !copy.onSelect) throw new Error('Copy missing')
    copy.onSelect()
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('paste-as-plain-text strips HTML and inserts text only', async () => {
    const readText = vi.fn().mockResolvedValue('plain inserted')
    Object.assign(navigator, { clipboard: { writeText: vi.fn(), readText } })

    const view = new EditorView({
      state: EditorState.create({ doc: 'AB', selection: { anchor: 1, head: 1 } }),
    })
    const menu = buildEditorContextMenu(view)
    const paste = menu.items.find((e) => e.kind === 'item' && e.title === 'Paste as plain text')
    if (!paste || paste.kind !== 'item' || !paste.onSelect) throw new Error('paste plain missing')
    await paste.onSelect()
    expect(view.state.doc.toString()).toBe('Aplain insertedB')
  })
})
