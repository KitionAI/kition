   
                                                                      
  
                                           
  
                                                          
                                                                  
                                                             
                                                       
                        
  
                                                              
                            
   
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { livePreviewExtension, livePreviewField, scanATXHeadings, scanFencedCodeBlocks } from './live-preview'

const mounts: Array<() => void> = []

afterEach(() => {
  while (mounts.length) mounts.pop()!()
})

const mountEditor = (
  doc: string,
  cursorPos?: number,
  sourcePath = '',
  revealSourceOnFocus = true,
  onMarkdownLinkNavigate?: (href: string) => boolean,
  onImagePreview?: (request: { src: string; alt: string }) => void,
) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: cursorPos != null ? EditorSelection.cursor(cursorPos) : undefined,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewExtension({
          sourcePath,
          revealSourceOnFocus,
          onMarkdownLinkNavigate,
          onImagePreview,
        }),
      ],
    }),
  })
  const cleanup = () => {
    view.destroy()
    host.remove()
  }
  mounts.push(cleanup)
  return view
}

const codeBlockActions = (view: EditorView): Element | null =>
  view.dom.querySelector('.cm-md-codeblock-actions')

describe('livePreviewExtension — images', () => {
  const image = (view: EditorView) => view.dom.querySelector('.cm-md-image img')
  const zoomButton = (view: EditorView) => (
    view.dom.querySelector('.cm-md-image-zoom') as HTMLButtonElement | null
  )
  const sourceToggle = (view: EditorView) => (
    view.dom.querySelector('.cm-md-image-source-toggle') as HTMLButtonElement | null
  )
  const imageWidgetEstimatedHeight = (view: EditorView): number | null => {
    let height: number | null = null
    view.state.field(livePreviewField).between(0, view.state.doc.length, (_from, _to, value) => {
      const widget = (value as unknown as { widget?: { estimatedHeight?: number } }).widget
      if (widget && typeof widget.estimatedHeight === 'number') {
        height = widget.estimatedHeight
      }
    })
    return height
  }

  it('reserves height for standalone images before their DOM is measured', () => {
    const view = mountEditor('![diagram](Attachments/diagram.png)', 0, 'Notes/demo.md')
    const block = view.dom.querySelector('.cm-md-image-block')
    const img = image(view) as HTMLImageElement | null

    expect(imageWidgetEstimatedHeight(view)).toBe(320)
    expect(block?.classList.contains('is-loading')).toBe(true)
    expect(img?.loading).toBe('eager')

    img?.dispatchEvent(new Event('load'))

    expect(block?.classList.contains('is-loading')).toBe(false)
  })

  it('does not add a block-height estimate to inline images', () => {
    const view = mountEditor('Before ![diagram](Attachments/diagram.png) after', 0, 'Notes/demo.md')

    expect(imageWidgetEstimatedHeight(view)).toBe(-1)
    expect(view.dom.querySelector('.cm-md-image-block')).toBeNull()
  })

  it('resolves angle-bracket generated image destinations from the workspace root', () => {
    const desktopWindow = window as typeof window & { kitionDesktop?: unknown }
    const previousDesktopBridge = desktopWindow.kitionDesktop
    desktopWindow.kitionDesktop = { shell: 'electron' }
    mounts.push(() => {
      desktopWindow.kitionDesktop = previousDesktopBridge
    })
    const view = mountEditor(
      '![Generated image](<Agent/images/9/ig_generated.png>)',
      0,
      'Articles/AI/Attention residue.md',
    )

    expect((image(view) as HTMLImageElement | null)?.src).toBe(
      'http://127.0.0.1:18101/workspace-files/Agent/images/9/ig_generated.png',
    )
  })

  it('keeps a pasted wikilink image rendered when the cursor moves beside or into its source range', () => {
    const source = '![[Attachments/Pasted image 20260718005317.png]]\nafter'
    const view = mountEditor(source, 3, 'Notes/demo.md')

    expect(image(view)).not.toBeNull()
    expect(sourceToggle(view)).not.toBeNull()
    expect(view.dom.querySelector('.cm-md-image-src')).toBeNull()

    view.dispatch({ selection: EditorSelection.cursor(12) })

    expect(image(view)).not.toBeNull()
    expect(view.dom.querySelector('.cm-md-image-src')).toBeNull()
    expect(view.dom.textContent).not.toContain('![[Attachments/Pasted image')
  })

  it('shows editable wikilink source only from the image button and keeps the image visible', () => {
    const source = '![[Attachments/Pasted image 20260718005317.png]]\nafter'
    const view = mountEditor(source, source.length, 'Notes/demo.md')

    sourceToggle(view)?.click()

    expect(view.dom.querySelector('.cm-md-image-src')?.textContent).toContain('Pasted image 20260718005317.png')
    expect(image(view)).not.toBeNull()
    expect(sourceToggle(view)?.getAttribute('aria-pressed')).toBe('true')

    view.dispatch({ selection: EditorSelection.cursor(source.length) })

    expect(view.dom.querySelector('.cm-md-image-src')).toBeNull()
    expect(image(view)).not.toBeNull()
  })

  it('uses the same persistent-image source toggle for Markdown image syntax', () => {
    const source = '![diagram](Attachments/diagram.png)\nafter'
    const view = mountEditor(source, 4, 'Notes/demo.md')

    expect(image(view)).not.toBeNull()
    expect(view.dom.querySelector('.cm-md-image-src')).toBeNull()

    sourceToggle(view)?.click()

    expect(view.dom.querySelector('.cm-md-image-src')?.textContent).toContain('![diagram]')
    expect(image(view)).not.toBeNull()
  })

  it('opens the image preview from the hover action button', () => {
    const onImagePreview = vi.fn()
    const view = mountEditor(
      '![Diagram](https://example.com/diagram.png)',
      0,
      '',
      true,
      undefined,
      onImagePreview,
    )

    zoomButton(view)?.click()

    expect(onImagePreview).toHaveBeenCalledWith({
      src: 'https://example.com/diagram.png',
      alt: 'Diagram',
    })
  })

  it('shows the image-specific context menu and removes the image source', () => {
    const source = '![Diagram](https://example.com/diagram.png)\nafter'
    const imageSource = source.slice(0, source.indexOf('\n'))
    const view = mountEditor(source, 0)
    const contextEvent = new MouseEvent('contextmenu', {
      clientX: 120,
      clientY: 160,
      bubbles: true,
      cancelable: true,
    })

    image(view)?.dispatchEvent(contextEvent)

    expect(contextEvent.defaultPrevented).toBe(true)
    const items = Array.from(document.querySelectorAll<HTMLElement>('.document-menu-item'))
    expect(items.map((item) => item.textContent)).toEqual([
      'Copy image',
      'Remove image',
      'Reset size',
    ])
    items.find((item) => item.textContent === 'Remove image')?.click()
    expect(view.state.doc.toString()).toBe(source.slice(imageSource.length + 1))
  })

  it('applies a custom embedded image width', () => {
    const view = mountEditor('![[Attachments/diagram.png|320]]', 0, 'Notes/demo.md')

    expect((image(view) as HTMLImageElement | null)?.style.width).toBe('320px')
  })
})

describe('livePreviewExtension — reading selection', () => {
  it('keeps Markdown markers hidden while a read-only document is focused', () => {
    const source = '# Heading\n\n**Bold text**'
    const view = mountEditor(source, source.length - 2, '', false)

    view.focus()

    expect(view.dom.querySelector('.cm-md-h-mark-hidden')).not.toBeNull()
    expect(view.dom.textContent).not.toContain('**')
  })
})

describe('livePreviewExtension — links', () => {
  it('delegates rendered Markdown links to workspace navigation before opening a window', () => {
    const onMarkdownLinkNavigate = vi.fn(() => true)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    mounts.push(() => open.mockRestore())
    const href = 'campaigns/2026-08-x-open-source/README.md'
    const view = mountEditor(
      `Before [campaign](${href})`,
      0,
      'README.md',
      true,
      onMarkdownLinkNavigate,
    )
    const link = view.dom.querySelector('.cm-md-link[data-href]') as HTMLElement | null

    expect(link).not.toBeNull()
    link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))

    expect(onMarkdownLinkNavigate).toHaveBeenCalledWith(href)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('livePreviewExtension — task lists', () => {
  const focus = (view: EditorView) => {
    view.contentDOM.focus()
    view.contentDOM.dispatchEvent(new FocusEvent('focus'))
  }

  it('renders a checkbox without a separate bullet marker', () => {
    const view = mountEditor('- [ ] Task')

    expect(view.dom.querySelectorAll('.cm-md-task-checkbox')).toHaveLength(1)
    expect(view.dom.querySelector('.cm-md-bullet')).toBeNull()
    expect(view.dom.querySelector('.cm-line')?.textContent).not.toContain('-')
  })

  it('keeps the checkbox rendered when the task line is active', () => {
    const view = mountEditor('- [x] Done', 3)
    focus(view)

    expect(view.dom.querySelectorAll('.cm-md-task-checkbox')).toHaveLength(1)
    expect(view.dom.querySelector('.cm-md-bullet')).toBeNull()
    expect(view.dom.querySelector('.cm-line')?.textContent).not.toContain('[x]')
    expect(view.dom.querySelector('.cm-line')?.textContent).not.toContain('-')
  })

  it('keeps the bullet widget for a regular list item', () => {
    const view = mountEditor('- Item')

    expect(view.dom.querySelectorAll('.cm-md-bullet')).toHaveLength(1)
    expect(view.dom.querySelector('.cm-md-task-checkbox')).toBeNull()
  })

  it('replaces an ordered task marker with only the checkbox', () => {
    const view = mountEditor('1. [ ] Task')

    expect(view.dom.querySelectorAll('.cm-md-task-checkbox')).toHaveLength(1)
    expect(view.dom.querySelector('.cm-md-list-mark')).toBeNull()
    expect(view.dom.querySelector('.cm-line')?.textContent).not.toContain('1.')
  })

  it('keeps completed task text muted when the document line color inherits', () => {
    const view = mountEditor('- [x] Done')
    const host = view.dom.parentElement!
    const style = document.createElement('style')
    style.textContent = '.document-editor .cm-line { color: inherit; }'
    document.head.appendChild(style)
    mounts.push(() => style.remove())
    host.classList.add('document-editor')
    host.style.color = 'rgb(238, 238, 238)'
    host.style.setProperty('--document-muted-text', 'rgb(168, 168, 168)')

    const line = view.dom.querySelector('.cm-line.cm-md-task-done') as HTMLElement

    expect(getComputedStyle(line).color).toContain('--document-muted-text')
  })

  it('toggles the Markdown task marker from the rendered checkbox', () => {
    const view = mountEditor('- [ ] Task')
    const checkbox = view.dom.querySelector('.cm-md-task-checkbox input') as HTMLInputElement

    checkbox.click()

    expect(view.state.doc.toString()).toBe('- [x] Task')
  })
})

describe('livePreviewExtension — fenced code block', () => {
  it('keeps the code-actions widget DOM stable when typing inside the block', () => {
    const view = mountEditor('```bash\nmlx_lm.lora\n```\n')

    const before = codeBlockActions(view)
    expect(before, 'actions widget should render once block has code').not.toBeNull()

                           
    const line2 = view.state.doc.line(2)
    view.dispatch({
      changes: { from: line2.to, insert: 'x' },
    })

    const after = codeBlockActions(view)
    expect(after, 'actions widget should still exist after edit').not.toBeNull()
                                                       
                     
    expect(after).toBe(before)
  })

  it('keeps the actions widget DOM stable across many keystrokes', () => {
    const view = mountEditor('```bash\nseed\n```\n')
    const initial = codeBlockActions(view)
    expect(initial).not.toBeNull()

    for (let i = 0; i < 5; i++) {
      const line2 = view.state.doc.line(2)
      view.dispatch({
        changes: { from: line2.to, insert: 'y' },
      })
      const current = codeBlockActions(view)
      expect(current, `keystroke ${i + 1}: actions widget should be stable`).toBe(initial)
    }
  })

  it('renders one clickable lang label + an svg copy icon, and hides the raw fence lang text', () => {
                                                               
    const view = mountEditor('x\n```bash\nls -la\n```\n', 0)

    const actions = codeBlockActions(view)
    expect(actions, 'actions widget should render').not.toBeNull()

    const lang = actions!.querySelector('.cm-md-codeblock-lang')
    expect(lang?.textContent).toBe('bash')
    expect(lang?.getAttribute('role')).toBe('button')

    const copy = actions!.querySelector('button.cm-md-codeblock-copy')
    expect(copy, 'copy button should render').not.toBeNull()
    expect(copy!.querySelector('svg'), 'copy button should be an icon').not.toBeNull()
    expect(copy!.textContent?.trim()).toBe('')            

                                                    
                           
    const fenceLine = view.dom.querySelector('.cm-md-codeblock-fence')
    const bashCount = (fenceLine?.textContent?.match(/bash/g) ?? []).length
    expect(bashCount).toBe(1)
  })

     
                                                 
                                       
    
                                                                 
                                                                
                                                              
                                 
    
                                                      
                                                        
                             
     
  describe('source-flash on edits elsewhere', () => {
    const buildLongDoc = (preLines: number) => {
      const filler = Array.from({ length: preLines }, (_, i) => `line ${i + 1}`).join('\n')
      return `${filler}\n\`\`\`bash\nseed code\n\`\`\`\n`
    }

    it('text-scan finds the fence block at any doc length, including post-edit', () => {
      for (const N of [10, 200, 400, 800]) {
        const view = mountEditor(buildLongDoc(N), 0)

                 
        const before = scanFencedCodeBlocks(view.state)
        expect(before.length, `N=${N} initial scan should find one block`).toBe(1)
        expect(before[0].lang).toBe('bash')
        expect(before[0].openLineNumber).toBe(N + 1)

                                        
        const line1 = view.state.doc.line(1)
        view.dispatch({ changes: { from: line1.to, insert: 'x' } })

                                            
        const after = scanFencedCodeBlocks(view.state)
        expect(after.length, `N=${N} post-edit scan should still find one block`).toBe(1)
        expect(after[0].lang).toBe('bash')
        expect(after[0].openLineNumber).toBe(N + 1)
        expect(after[0].openMarkFrom).toBe(before[0].openMarkFrom + 1)

        view.destroy()
      }
    })
  })

     
                                                         
                                                            
                                                                            
    
                                                       
                                                             
                                                                    
                                 
    
                                                                  
                                                       
                                                   
                                                          
     
  describe('inline marker stability under partial tree', () => {
    const buildHeadingDoc = (preLines: number) => {
      const filler = Array.from({ length: preLines }, (_, i) => `line ${i + 1}`).join('\n\n')
      return `${filler}\n\n\`\`\`bash\nseed code\n\`\`\`\n\n## heading down here\n\nfollowed by **bold** and \`code\` and _em_.\n`
    }

    it('text-scan finds ATX headings at any doc length, including after edit elsewhere', () => {
      for (const N of [10, 200, 400, 800]) {
        const view = mountEditor(buildHeadingDoc(N), 0)

                                                               
        const fenced = scanFencedCodeBlocks(view.state)
        const before = scanATXHeadings(view.state, fenced)
        expect(before.length, `N=${N} initial scan should find the heading`).toBe(1)
        expect(before[0].level).toBe(2)

                                        
        const line1 = view.state.doc.line(1)
        view.dispatch({ changes: { from: line1.to, insert: 'x' } })

        const fencedAfter = scanFencedCodeBlocks(view.state)
        const after = scanATXHeadings(view.state, fencedAfter)
        expect(after.length, `N=${N} post-edit scan should still find the heading`).toBe(1)
        expect(after[0].level).toBe(2)
        expect(after[0].markFrom).toBe(before[0].markFrom + 1)

        view.destroy()
      }
    })

    it('text-scan ignores `#` lines inside fenced code blocks', () => {
      const view = mountEditor('# real heading\n\n```md\n# fake heading inside fence\n```\n')
      const fenced = scanFencedCodeBlocks(view.state)
      const heads = scanATXHeadings(view.state, fenced)
      expect(heads.length).toBe(1)
      expect(heads[0].line).toBe(1)
    })

    it('text-scan rejects `#text` without trailing space (per CommonMark)', () => {
      const view = mountEditor('#notaheading\n\n# real heading\n')
      const fenced = scanFencedCodeBlocks(view.state)
      const heads = scanATXHeadings(view.state, fenced)
      expect(heads.length).toBe(1)
      expect(heads[0].line).toBe(3)
    })

    it('keeps decoration-set size stable across keystrokes (smoke test)', () => {
      const view = mountEditor(buildHeadingDoc(20), 0)
      const beforeSize = view.state.field(livePreviewField).size

      const line1 = view.state.doc.line(1)
      view.dispatch({ changes: { from: line1.to, insert: 'x' } })

      const afterSize = view.state.field(livePreviewField).size
      expect(
        Math.abs(afterSize - beforeSize),
        `decoration-set size should be stable (before=${beforeSize}, after=${afterSize})`,
      ).toBeLessThanOrEqual(2)
    })

    it('preserves decoration-set size across many keystrokes (smoke test)', () => {
      const view = mountEditor(buildHeadingDoc(20), 0)
      const initial = view.state.field(livePreviewField).size

      for (let i = 0; i < 8; i++) {
        const line1 = view.state.doc.line(1)
        view.dispatch({ changes: { from: line1.to, insert: 'y' } })
      }

      const final = view.state.field(livePreviewField).size
      expect(
        Math.abs(final - initial),
        `decoration count after 8 keystrokes (initial=${initial}, final=${final})`,
      ).toBeLessThanOrEqual(2)
    })
  })

     
                                                        
                                                           
    
                                                                                           
                                                      
                                                                           
                                       
    
                                                                 
                                                                   
                   
     
  describe('inline emphasis markers reveal as one unit', () => {
    const focus = (view: EditorView) => {
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
    }

    const strongTextAt = (view: EditorView): string | null => {
      const el = view.dom.querySelector('.cm-md-strong')
      return el ? el.textContent : null
    }
    const emTextAt = (view: EditorView): string | null => {
      const el = view.dom.querySelector('.cm-md-em')
      return el ? el.textContent : null
    }
    const codeTextAt = (view: EditorView): string | null => {
      const el = view.dom.querySelector('.cm-md-code')
      return el ? el.textContent : null
    }
    const strikeTextAt = (view: EditorView): string | null => {
      const el = view.dom.querySelector('.cm-md-strike')
      return el ? el.textContent : null
    }

    it('reveals both **bold** markers when cursor sits just before the closing **', () => {
      // Source: `**3333**`. Cursor at pos 6 = between '3' and '*'.
      const view = mountEditor('**3333**', 6)
      focus(view)
      expect(strongTextAt(view)).toBe('**3333**')
    })

    it('reveals both **bold** markers when cursor sits just after the opening **', () => {
      const view = mountEditor('**3333**', 2)
      focus(view)
      expect(strongTextAt(view)).toBe('**3333**')
    })

    it('reveals both **bold** markers when cursor is in the middle of the text', () => {
      const view = mountEditor('**3333**', 4)
      focus(view)
      expect(strongTextAt(view)).toBe('**3333**')
    })

    it('hides both **bold** markers when cursor is far from the bold range', () => {
      // doc: `**3333** more`. Cursor far away → both `**` should hide.
      const view = mountEditor('**3333** more text here', 20)
      focus(view)
      // strong span exists but its rendered text excludes the two `**`
      expect(strongTextAt(view)).toBe('3333')
    })

    it('reveals both *em* markers when cursor sits just before the closing *', () => {
      // Source: `*ab*`. EmphasisMark(0,1) and (3,4). Cursor at 3.
      const view = mountEditor('*ab*', 3)
      focus(view)
      expect(emTextAt(view)).toBe('*ab*')
    })

    it('reveals both ~~strike~~ markers when cursor sits just before the closing ~~', () => {
      const view = mountEditor('~~xy~~', 4)
      focus(view)
      expect(strikeTextAt(view)).toBe('~~xy~~')
    })

    it('reveals both `code` markers when cursor sits just before the closing backtick', () => {
      const view = mountEditor('`xy`', 3)
      focus(view)
      expect(codeTextAt(view)).toBe('`xy`')
    })
  })

     
                                                         
                                    
    
        
                                                                                   
                                                                          
                                           
                                                                               
                                                                          
                        
    
                                                                                   
                                                                                             
                             
                         
                                                      
     
  describe('escape sequence `\\*` renders correctly in live preview', () => {
    const focus = (view: EditorView) => {
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
    }

                                                                  
                          
    const lineText = (view: EditorView, lineIdx = 0): string => {
      const lines = view.dom.querySelectorAll('.cm-line')
      return lines[lineIdx]?.textContent ?? ''
    }

    it('hides the backslash on inactive lines (no focus → user sees just `*hello`)', () => {
      const view = mountEditor('\\*hello')
                                                               
      expect(lineText(view)).toBe('*hello')
    })

    it('reveals the backslash on the active line when the editor is focused and cursor sits on it', () => {
                                                             
      const view = mountEditor('\\*hello', 3)
      focus(view)
      expect(lineText(view)).toBe('\\*hello')
    })

    it('does not produce emphasis when both `*` are escaped (`\\*foo\\*` is plain text)', () => {
                                                        
      const view = mountEditor('\\*foo\\* bar')
      expect(view.dom.querySelector('.cm-md-em')).toBeNull()
      expect(view.dom.querySelector('.cm-md-strong')).toBeNull()
    })

    it('marks the escaped character with `cm-md-escape-char` so its color is not the orange #e40 from defaultHighlightStyle', () => {
      const view = mountEditor('\\*x')
                                                         
                                                       
      const el = view.dom.querySelector('.cm-md-escape-char')
      expect(el?.textContent).toBe('*')
    })

    it('on a multi-line doc, hides the backslash on the inactive line even when cursor is focused elsewhere', () => {
                                                              
                              
      const view = mountEditor('\\*line1\nnormal line', 10)
      focus(view)
      expect(lineText(view, 0)).toBe('*line1')
      expect(lineText(view, 1)).toBe('normal line')
    })

    it('marks the backslash with `cm-md-escape-backslash` (dim) when shown on the active line', () => {
      const view = mountEditor('\\*hello', 3)
      focus(view)
      const el = view.dom.querySelector('.cm-md-escape-backslash')
      expect(el?.textContent).toBe('\\')
    })
  })

     
                                                        
                                                                     
                                                                   
                                    
    
        
                                                                
                                                            
                                                                                
                                                                         
                                                                           
    
                                          
                                                                 
                                  
                                                                        
                   
     
  describe('html entity `&nbsp;` decodes correctly in live preview', () => {
    const focus = (view: EditorView) => {
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
    }
    const lineText = (view: EditorView, lineIdx = 0): string => {
      const lines = view.dom.querySelectorAll('.cm-line')
      return lines[lineIdx]?.textContent ?? ''
    }

    it('decodes `&nbsp;` to non-breaking space on inactive lines', () => {
      const view = mountEditor('a&nbsp;b')
                                            
      expect(lineText(view)).toBe('a b')
    })

    it('reveals literal `&nbsp;` source on the active line when editor is focused', () => {
      const view = mountEditor('a&nbsp;b', 4)
      focus(view)
                                         
      expect(lineText(view)).toBe('a&nbsp;b')
    })

    it('decodes `&amp;` to `&` on inactive lines', () => {
      const view = mountEditor('x&amp;y')
      expect(lineText(view)).toBe('x&y')
    })

    it('decodes numeric entity `&#160;` to non-breaking space on inactive lines', () => {
      const view = mountEditor('a&#160;b')
      expect(lineText(view)).toBe('a b')
    })

    it('decodes hex entity `&#xa0;` to non-breaking space on inactive lines', () => {
      const view = mountEditor('a&#xa0;b')
      expect(lineText(view)).toBe('a b')
    })

    it('handles multiple entities on the same line independently', () => {
      const view = mountEditor('a&nbsp;b&amp;c')
      expect(lineText(view)).toBe('a b&c')
    })

    it('marks the entity source with `cm-md-entity-source` on the active line (to override the red #a11 from defaultHighlightStyle)', () => {
      const view = mountEditor('a&nbsp;b', 4)
      focus(view)
      const el = view.dom.querySelector('.cm-md-entity-source')
      expect(el?.textContent).toBe('&nbsp;')
    })

    it('does not affect entities inside fenced code blocks (lezer does not parse Entity inside code)', () => {
      const view = mountEditor('```\n&nbsp;\n```\n')
                                    
      expect(view.dom.textContent ?? '').toContain('&nbsp;')
    })
  })

     
                                                    
                             
    
                                                            
                                                          
                              
    
                                                                      
                                  
     
  describe('inline link expand/collapse vs selection position', () => {
    const focus = (view: EditorView) => {
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
    }
    const linkSpan = (view: EditorView): Element | null =>
      view.dom.querySelector('.cm-md-link')

    it('stays collapsed when the selection starts immediately after the closing `)`', () => {
                                                              
                                               
      const doc = `before [label](https://example.com)${String.fromCodePoint(0x3002)}trailing text selected`
      const closeParen = doc.indexOf(')')
                                                               
                                            
      const selStart = closeParen + 2
      const view = mountEditor(doc)
      focus(view)
      view.dispatch({
        selection: EditorSelection.range(selStart, doc.length),
      })
      const el = linkSpan(view)
      expect(el).not.toBeNull()
      expect(el!.classList.contains('cm-md-link-expanded')).toBe(false)
    })

    it('expands when the cursor sits inside the link label', () => {
      const doc = 'before [label](https://example.com) tail'
      const labelMid = doc.indexOf('label') + 2
      const view = mountEditor(doc, labelMid)
      focus(view)
      const el = linkSpan(view)
      expect(el).not.toBeNull()
      expect(el!.classList.contains('cm-md-link-expanded')).toBe(true)
    })

    it('stays collapsed when the cursor sits one char before the opening `[`', () => {
                                                               
                             
      const doc = 'before [label](https://example.com) tail'
      const openBracket = doc.indexOf('[')
      const view = mountEditor(doc, openBracket - 1)
      focus(view)
      const el = linkSpan(view)
      expect(el).not.toBeNull()
      expect(el!.classList.contains('cm-md-link-expanded')).toBe(false)
    })
  })
})
