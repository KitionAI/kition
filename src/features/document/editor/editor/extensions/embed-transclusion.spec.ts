import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { embedTransclusionExtension } from './embed-transclusion'

function makeView(doc: string, opts: { onNavigate?: any } = {}) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      embedTransclusionExtension({
        load: async (target) => ({
          path: target + '.md',
          content: `# ${target}\nbody for ${target}`,
        }),
        onNavigate: opts.onNavigate,
      }),
    ],
  })
  return new EditorView({ state, parent })
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('embedTransclusionExtension', () => {
  it('renders .markdown-embed DOM for standalone ![[X]]', async () => {
    const view = makeView('![[X]]')
    await flushMicrotasks()
    await flushMicrotasks()
    const embed = view.dom.querySelector('.markdown-embed.inline-embed')
    expect(embed, 'embed root should exist').toBeTruthy()
    expect(embed?.querySelector('.markdown-embed-title')?.textContent).toBe('X')
    expect(embed?.querySelector('.markdown-embed-content')).toBeTruthy()
    expect(embed?.querySelector('.markdown-embed-link')).toBeTruthy()
    view.destroy()
  })

  it('renders markdown body (h1, p) instead of plain text', async () => {
    const view = makeView('![[X]]')
    await flushMicrotasks()
    await flushMicrotasks()
    const content = view.dom.querySelector('.markdown-embed-content')
    expect(content?.querySelector('h1')?.textContent).toContain('X')
    view.destroy()
  })

  it('uses Heading as title for ![[X#Heading]]', async () => {
    const view = makeView('![[X#Heading]]')
    await flushMicrotasks()
    await flushMicrotasks()
    const title = view.dom.querySelector('.markdown-embed-title')
    expect(title?.textContent).toBe('Heading')
    view.destroy()
  })

  it('skips image extensions (defers to mediaDeco)', async () => {
    const view = makeView('![[pic.png]]')
    await flushMicrotasks()
    expect(view.dom.querySelector('.markdown-embed')).toBeNull()
    view.destroy()
  })

  it('markdown-embed-link click calls onNavigate', async () => {
    const onNavigate = vi.fn()
    const view = makeView('![[X]]', { onNavigate })
    await flushMicrotasks()
    await flushMicrotasks()
    const icon = view.dom.querySelector('.markdown-embed-link') as HTMLElement | null
    expect(icon).toBeTruthy()
    icon!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate.mock.calls[0][0]).toBe('X')
    view.destroy()
  })

  it('shows section in navigate call for ![[X#H]]', async () => {
    const onNavigate = vi.fn()
    const view = makeView('![[X#H]]', { onNavigate })
    await flushMicrotasks()
    await flushMicrotasks()
    const icon = view.dom.querySelector('.markdown-embed-link') as HTMLElement | null
    icon!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onNavigate.mock.calls[0][1]).toBe('#H')
    view.destroy()
  })
})
