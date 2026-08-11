import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { livePreviewExtension } from './live-preview'
import { wikilinkExtension, type WikilinkExtensionOptions } from './wikilink'
import {
  buildTableMarkdown,
  renderCellHtml,
  splitRowCells,
  type TableModel,
} from './table-widget'

describe('buildTableMarkdown round-trip', () => {
  it('escapes pipe characters in cell text', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: 'a | b' }, { text: 'c' }],
      aligns: [null, null],
      rows: [[{ text: 'pipe | inside' }, { text: 'x' }]],
    }
    const md = buildTableMarkdown(model)
    expect(md).toContain('a \\| b')
    expect(md).toContain('pipe \\| inside')
  })

                                                                
                                                                  
  it('does NOT escape pipes inside inline math', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: '$|\\Theta|$' }, { text: 'c' }],
      aligns: [null, null],
      rows: [[{ text: '$a|b$' }, { text: 'x' }]],
    }
    const md = buildTableMarkdown(model)
    expect(md).toContain('$|\\Theta|$')
    expect(md).not.toContain('$\\|')
    expect(md).toContain('$a|b$')
  })

  it('does NOT escape pipes inside display math $$...$$', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: '$$|x|$$' }, { text: 'c' }],
      aligns: [null, null],
      rows: [],
    }
    const md = buildTableMarkdown(model)
    expect(md).toContain('$$|x|$$')
  })

  it('does NOT escape pipes inside inline code spans', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: '`a|b`' }, { text: 'c' }],
      aligns: [null, null],
      rows: [],
    }
    const md = buildTableMarkdown(model)
    expect(md).toContain('`a|b`')
  })

  it('preserves alignment markers', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: 'L' }, { text: 'C' }, { text: 'R' }],
      aligns: ['left', 'center', 'right'],
      rows: [],
    }
    const md = buildTableMarkdown(model)
    expect(md).toContain('|:---|:---:|---:|')
  })

  it('synthesizes empty cells when row shorter than headers', () => {
    const model: TableModel = {
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: 'h1' }, { text: 'h2' }, { text: 'h3' }],
      aligns: [null, null, null],
      rows: [[{ text: 'only one' }]],
    }
    const md = buildTableMarkdown(model)
    const lines = md.split('\n')
    expect(lines[2]).toBe('| only one |  |  |')
  })
})

describe('splitRowCells', () => {
  it('splits plain row by unescaped pipes', () => {
    expect(splitRowCells('| a | b | c |')).toEqual(['a', 'b', 'c'])
  })

  it('treats \\| as literal pipe inside a cell', () => {
    expect(splitRowCells('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('handles multiple escapes in one cell', () => {
    expect(splitRowCells('| x \\| y \\| z | w |')).toEqual(['x | y | z', 'w'])
  })

                                                  
                                                            
                                              
  it('preserves pipes inside inline math $...$', () => {
    expect(splitRowCells('| $|\\Theta|$ | 0.5M | 11M | 11M |')).toEqual([
      '$|\\Theta|$',
      '0.5M',
      '11M',
      '11M',
    ])
  })

  it('keeps separate math spans in separate cells', () => {
    expect(splitRowCells('| $a|b$ | $c|d$ |')).toEqual(['$a|b$', '$c|d$'])
  })

  it('treats `$1 | $2` as TWO cells (currency, not math — opening $ followed by digit but closing $ preceded by whitespace)', () => {
                                                                 
    expect(splitRowCells('| $1 | $2 |')).toEqual(['$1', '$2'])
  })

  it('preserves pipes inside display math $$...$$', () => {
    expect(splitRowCells('| $$|x|$$ | y |')).toEqual(['$$|x|$$', 'y'])
  })

  it('preserves pipes inside inline code spans', () => {
    expect(splitRowCells('| `a|b` | c |')).toEqual(['`a|b`', 'c'])
  })

  it('preserves pipes inside math even when math contains backslashes', () => {
                                                            
    expect(splitRowCells('| $\\Theta|\\alpha$ | y |')).toEqual([
      '$\\Theta|\\alpha$',
      'y',
    ])
  })

  it('unterminated `$` falls through as plain text', () => {
                                     
    expect(splitRowCells('| $x | y |')).toEqual(['$x', 'y'])
  })
})

describe('renderCellHtml', () => {
  it('renders inline math via KaTeX', () => {
    const html = renderCellHtml('$x^2$')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$x^2$')
  })

  it('renders empty string as empty', () => {
    expect(renderCellHtml('')).toBe('')
  })

  it('renders bold inline markdown', () => {
    expect(renderCellHtml('**bold**')).toContain('<strong>bold</strong>')
  })

  it('removes executable HTML from table cell markdown', () => {
    const html = renderCellHtml('<img src="missing.png" onerror="window.__kition_xss = true">')

    expect(html).toContain('src="missing.png"')
    expect(html).not.toContain('onerror')
  })

  it('leaves plain text untouched (modulo marked inline transforms)', () => {
    expect(renderCellHtml('plain text')).toContain('plain text')
  })

  it('renders internal links without exposing the bracket syntax', () => {
    const html = renderCellHtml('[[Essentials/Task Tracker.kitable]]')
    expect(html).toContain('class="cm-hmd-internal-link table-cell-wikilink"')
    expect(html).toContain('data-target="Essentials/Task Tracker.kitable"')
    expect(html).toContain('Essentials/Task Tracker.kitable')
    expect(html).not.toContain('[[Essentials/Task Tracker.kitable]]')
  })

  it('uses the internal link alias as its visible label', () => {
    const html = renderCellHtml('[[Essentials/Task Tracker.kitable|Task tracker]]')
    expect(html).toContain('>Task tracker</span>')
    expect(html).not.toContain('>Essentials/Task Tracker.kitable</span>')
  })
})

const mounts: Array<() => void> = []
afterEach(() => {
  while (mounts.length) mounts.pop()!()
})

function mountEditor(doc: string, wikilinkOptions: WikilinkExtensionOptions = {}): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewExtension(),
        wikilinkExtension(wikilinkOptions),
      ],
    }),
  })
  mounts.push(() => {
    view.destroy()
    host.remove()
  })
  return view
}

function getCellWrappers(view: EditorView): HTMLElement[] {
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>('.cm-table-widget .table-cell-wrapper'),
  )
}

describe('TableWidget cell rendering', () => {
  it('renders math inside table cells on mount', () => {
    const doc = [
      '',
      '| Variant | Scoring function |',
      '|------|----------|',
      '| ATIRE | $\\sum_{t \\in q} \\log(N/df_t)$ |',
      '',
    ].join('\n')
    const view = mountEditor(doc)

    const wrappers = getCellWrappers(view)
    expect(wrappers.length).toBeGreaterThan(0)

                        
    const mathCell = wrappers.find((w) => (w.dataset.rawText ?? '').includes('\\sum'))
    expect(mathCell, 'math cell should be present').toBeTruthy()
    expect(mathCell!.innerHTML).toContain('class="katex"')
    expect(mathCell!.innerHTML).not.toContain('$\\sum')
    expect(mathCell!.dataset.editMode).toBe('0')
  })

  it('switches to raw text on focus and re-renders on blur', () => {
    const doc = [
      '',
      '| h1 |',
      '|----|',
      '| $a^2$ |',
      '',
    ].join('\n')
    const view = mountEditor(doc)

    const mathCell = getCellWrappers(view).find((w) => (w.dataset.rawText ?? '').includes('a^2'))
    expect(mathCell, 'math cell should be present').toBeTruthy()

                       
    expect(mathCell!.innerHTML).toContain('class="katex"')

                                                                    
    mathCell!.dispatchEvent(new FocusEvent('focus'))
    expect(mathCell!.dataset.editMode).toBe('1')
    expect(mathCell!.textContent).toBe('$a^2$')

                     
    mathCell!.textContent = '$b^3$'
    mathCell!.dispatchEvent(new FocusEvent('blur'))

    expect(mathCell!.dataset.editMode).toBe('0')
    expect(mathCell!.dataset.rawText).toBe('$b^3$')
    expect(mathCell!.innerHTML).toContain('class="katex"')
    expect(mathCell!.innerHTML).not.toContain('$b^3$')
  })

  it('syncDomToDoc writes back raw markdown, not rendered text', () => {
                                                        
                                                             
    const doc = [
      '',
      '| h |',
      '|---|',
      '| $x^2$ |',
      '',
    ].join('\n')
    const view = mountEditor(doc)

                                                       
                                                                 
    view.dispatch({
      changes: { from: view.state.doc.length, insert: 'tail\n' },
    })

    const docText = view.state.doc.toString()
    expect(docText).toContain('$x^2$')
  })

                                                              
                                      
  it('parses pipes inside $|\\Theta|$ as math, not column separators', () => {
    const doc = [
      '',
      '| Batch size | 32 | 16 | 1 |',
      '|---|---|---|---|',
      '| Sequence length | 512 | 256 | 128 |',
      '| $|\\Theta|$ | 0.5M | 11M | 11M |',
      '',
    ].join('\n')
    const view = mountEditor(doc)

    const rows = view.dom.querySelectorAll<HTMLTableRowElement>(
      '.cm-table-widget tbody tr',
    )
    expect(rows.length).toBe(2)

    const mathRow = rows[1]
    const cells = mathRow.querySelectorAll<HTMLElement>('td .table-cell-wrapper')
                                 
    expect(cells.length).toBe(4)

                                            
    expect(cells[0].dataset.rawText).toBe('$|\\Theta|$')
                                       
    expect(cells[0].innerHTML).toContain('class="katex"')
    expect(cells[0].innerHTML).not.toContain('$|')
  })

                                                           
                                                
  it('round-trip preserves math cell verbatim (no spurious \\| escape)', () => {
    const doc = [
      '',
      '| h | v |',
      '|---|---|',
      '| $|\\Theta|$ | 0.5M |',
      '',
    ].join('\n')
    const view = mountEditor(doc)

                                                               
    const wrappers = getCellWrappers(view)
    const target = wrappers.find((w) => w.dataset.rawText === '0.5M')
    expect(target, 'target cell present').toBeTruthy()
    target!.dispatchEvent(new FocusEvent('focus'))
    target!.textContent = '0.6M'
    target!.dispatchEvent(new FocusEvent('blur'))

    const docText = view.state.doc.toString()
    expect(docText).toContain('$|\\Theta|$')
    expect(docText).not.toContain('$\\|\\Theta\\|$')
    expect(docText).toContain('0.6M')
  })

  it('opens an internal link without switching the table cell into edit mode', () => {
    const onNavigate = vi.fn()
    const doc = [
      '',
      '| Included table | Pattern |',
      '|---|---|',
      '| [[Essentials/Task Tracker.kitable]] | Personal work tracking |',
      '',
    ].join('\n')
    const view = mountEditor(doc, {
      sourcePath: 'welcome.md',
      resolve: () => true,
      onNavigate,
    })

    const link = view.dom.querySelector<HTMLElement>('.table-cell-wikilink')
    expect(link, 'table cell internal link should be present').toBeTruthy()
    const wrapper = link!.closest<HTMLElement>('.table-cell-wrapper')

    link!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate.mock.calls[0][0]).toMatchObject({
      target: 'Essentials/Task Tracker.kitable',
    })
    expect(onNavigate.mock.calls[0][1]).toMatchObject({ sourcePath: 'welcome.md' })
    expect(wrapper?.dataset.editMode).toBe('0')
  })

  it('uses the existing missing-note action for an unresolved table cell link', () => {
    const onCreateMissing = vi.fn()
    const doc = [
      '',
      '| Included table |',
      '|---|',
      '| [[Missing table.kitable]] |',
      '',
    ].join('\n')
    const view = mountEditor(doc, {
      sourcePath: 'welcome.md',
      resolve: () => false,
      onCreateMissing,
    })

    const link = view.dom.querySelector<HTMLElement>('.table-cell-wikilink')
    expect(link, 'unresolved table cell internal link should be present').toBeTruthy()
    link!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(onCreateMissing).toHaveBeenCalledWith('Missing table.kitable', 'welcome.md')
  })
})
