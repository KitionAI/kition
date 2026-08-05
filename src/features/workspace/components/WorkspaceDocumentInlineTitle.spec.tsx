import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceDocumentInlineTitle } from './WorkspaceDocumentInlineTitle'
import {
  clearDraftTitle,
  getDraftTitleSnapshot,
} from '@/features/workspace/lib/draftTitleStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => { root?.unmount() })
  root = null
  container?.remove()
}

const titleEl = () =>
  container.querySelector('[data-testid="workspace-document-inline-title"]') as HTMLElement

describe('WorkspaceDocumentInlineTitle', () => {
  beforeEach(async () => { await unmount(); clearDraftTitle() })
  afterEach(async () => { await unmount(); clearDraftTitle() })

  it('renders the value into a contentEditable element', async () => {
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: '2026-06-19',
      onCommit: () => {},
    }))
    const el = titleEl()
    expect(el).toBeTruthy()
    expect(el.getAttribute('contenteditable')).toBe('true')
    expect(el.textContent).toBe('2026-06-19')
  })

  it('renders contentEditable=false when disabled', async () => {
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'x',
      onCommit: () => {},
      disabled: true,
    }))
    expect(titleEl().getAttribute('contenteditable')).toBe('false')
  })

  it('broadcasts every input to the draft title store', async () => {
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit: () => {},
    }))
    const el = titleEl()
    await act(async () => {
      el.textContent = 'orig-new'
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    expect(getDraftTitleSnapshot()).toEqual({ path: 'notes/a.md', draft: 'orig-new' })
  })

  it('calls onCommit on blur with the latest text content', async () => {
    const onCommit = vi.fn()
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit,
    }))
    const el = titleEl()
    await act(async () => {
      el.textContent = 'changed'
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      // React 18 delegates onBlur via focusout (which natively bubbles)
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onCommit).toHaveBeenCalledWith('changed')
  })

  it('does NOT call onCommit on blur when the value did not change', async () => {
    const onCommit = vi.fn()
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit,
    }))
    const el = titleEl()
    await act(async () => {
      // React 18 delegates onBlur via focusout (which natively bubbles)
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Enter commits and triggers onFocusEditor', async () => {
    const onCommit = vi.fn()
    const onFocusEditor = vi.fn()
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit,
      onFocusEditor,
    }))
    const el = titleEl()
    await act(async () => {
      el.textContent = 'after-enter'
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onCommit).toHaveBeenCalledWith('after-enter')
    expect(onFocusEditor).toHaveBeenCalled()
  })

  it('Escape restores the original text and does not commit', async () => {
    const onCommit = vi.fn()
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit,
    }))
    const el = titleEl()
    await act(async () => {
      el.textContent = 'typed-but-bailed'
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(el.textContent).toBe('orig')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('keystrokes during IME composition do NOT broadcast to draft store', async () => {
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit: () => {},
    }))
    const el = titleEl()
    await act(async () => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.textContent = `orig${String.fromCodePoint(0x4f60)}`
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    expect(getDraftTitleSnapshot()).toBeNull()
    await act(async () => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await Promise.resolve() // drain microtask queue for queueMicrotask(broadcast)
      await Promise.resolve() // belt-and-suspenders
    })
    expect(getDraftTitleSnapshot()).toEqual({ path: 'notes/a.md', draft: `orig${String.fromCodePoint(0x4f60)}` })
  })

  it('does not commit or focus the editor when Enter confirms IME composition', async () => {
    const onCommit = vi.fn()
    const onFocusEditor = vi.fn()
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'orig',
      onCommit,
      onFocusEditor,
    }))
    const el = titleEl()
    const composedTitle = `orig${String.fromCodePoint(0x4e2d)}`

    await act(async () => {
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.textContent = composedTitle
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
        keyCode: 229,
      }))
    })

    expect(onCommit).not.toHaveBeenCalled()
    expect(onFocusEditor).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(el)

    await act(async () => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await Promise.resolve()
    })
    expect(getDraftTitleSnapshot()).toEqual({ path: 'notes/a.md', draft: composedTitle })
  })

  it('syncs value prop changes when not focused', async () => {
    let renderCount = 0
    const Wrapper = ({ value }: { value: string }) => {
      renderCount++
      return createElement(WorkspaceDocumentInlineTitle, {
        documentPath: 'notes/a.md',
        value,
        onCommit: () => {},
      })
    }
    await mount(createElement(Wrapper, { value: 'first' }))
    expect(titleEl().textContent).toBe('first')
    await act(async () => {
      root!.render(createElement(Wrapper, { value: 'second' }))
      await Promise.resolve()
    })
    expect(titleEl().textContent).toBe('second')
    expect(renderCount).toBeGreaterThan(0)
  })

  it('does NOT overwrite textContent while the element is focused (caret safety)', async () => {
    await mount(createElement(WorkspaceDocumentInlineTitle, {
      documentPath: 'notes/a.md',
      value: 'first',
      onCommit: () => {},
    }))
    const el = titleEl()
    el.focus()
    await act(async () => {
      el.textContent = 'user-typing'
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      root!.render(createElement(WorkspaceDocumentInlineTitle, {
        documentPath: 'notes/a.md',
        value: 'remote-update',
        onCommit: () => {},
      }))
      await Promise.resolve()
    })
    expect(el.textContent).toBe('user-typing')
  })
})
