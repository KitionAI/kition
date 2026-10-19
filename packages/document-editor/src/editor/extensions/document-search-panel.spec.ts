import { openSearchPanel } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { documentSearchExtension } from './document-search-panel'

const mountedViews: EditorView[] = []

afterEach(() => {
  while (mountedViews.length > 0) mountedViews.pop()?.destroy()
  document.body.replaceChildren()
})

function mountEditor(doc: string): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [documentSearchExtension()],
    }),
  })
  mountedViews.push(view)
  return view
}

function inputValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('documentSearchExtension', () => {
  it('renders a compact panel with match count and navigation', () => {
    const view = mountEditor('Start here. Start again. start once more.')
    openSearchPanel(view)

    const panel = view.dom.querySelector('.document-find-panel')
    const input = panel?.querySelector<HTMLInputElement>('input[name="search"]')
    expect(panel).toBeTruthy()
    expect(input).toBeTruthy()

    inputValue(input!, 'Start')
    expect(panel?.querySelector('.document-find-panel__status')?.textContent).toBe('1 of 3')

    panel?.querySelector<HTMLButtonElement>('button[name="next"]')?.click()
    expect(panel?.querySelector('.document-find-panel__status')?.textContent).toBe('2 of 3')

    panel?.querySelector<HTMLButtonElement>('button[name="previous"]')?.click()
    expect(panel?.querySelector('.document-find-panel__status')?.textContent).toBe('1 of 3')
  })

  it('keeps replacement controls collapsed until requested', () => {
    const view = mountEditor('alpha alpha')
    openSearchPanel(view)

    const panel = view.dom.querySelector('.document-find-panel')
    const replaceRow = panel?.querySelector<HTMLDivElement>('.document-find-panel__replace-row')
    const toggle = panel?.querySelector<HTMLButtonElement>('button[name="toggleReplace"]')
    expect(replaceRow?.hidden).toBe(true)

    toggle?.click()
    expect(replaceRow?.hidden).toBe(false)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes with the panel close control', () => {
    const view = mountEditor('alpha')
    openSearchPanel(view)
    view.dom.querySelector<HTMLButtonElement>('button[name="close"]')?.click()
    expect(view.dom.querySelector('.document-find-panel')).toBeNull()
  })
})
