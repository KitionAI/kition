import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextBinding } from '../kdm/codeMirrorBinding'
import type { DocumentTextSource } from '../kdm/documentTextSource'
import { useDocumentBinding } from './useDocumentBinding'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** A text source that counts the bindings it handed out and has not had back. */
function countingSource(text: string) {
  const live = new Set<TextBinding>()
  const source = {
    live,
    text: () => text,
    createBinding: vi.fn(() => {
      const binding = { extension: [] } as unknown as TextBinding
      live.add(binding)
      return binding
    }),
    releaseBinding: vi.fn((binding: TextBinding) => {
      live.delete(binding)
    }),
    historyExtension: () => [],
    replaceText: () => false,
    applyFrom: () => false,
  }
  return source as typeof source & DocumentTextSource
}

let container: HTMLDivElement
let root: Root | null = null
const seen: Array<ReturnType<typeof useDocumentBinding>> = []

function Editor({ source }: { source: DocumentTextSource }) {
  seen.push(useDocumentBinding(source))
  return null
}

async function render(source: DocumentTextSource) {
  await act(async () => {
    root ??= createRoot(container)
    root.render(createElement(StrictMode, null, createElement(Editor, { source })))
  })
  await act(async () => {
    await vi.runAllTimersAsync()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  seen.length = 0
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useDocumentBinding', () => {
  it('keeps exactly one binding per mounted editor under StrictMode, and releases it on unmount', async () => {
    const source = countingSource('# Text\n')
    await render(source)
    expect(source.live.size).toBe(1)
    const latest = seen[seen.length - 1]
    expect(latest.initialText).toBe('# Text\n')
    expect(latest.extension).toContain([...source.live][0].extension)

    act(() => root?.unmount())
    root = null
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(source.live.size).toBe(0)
  })

  it('binds to a new source and releases the previous one’s binding', async () => {
    const first = countingSource('one\n')
    const second = countingSource('two\n')
    await render(first)
    await render(second)
    expect(first.live.size).toBe(0)
    expect(second.live.size).toBe(1)
    expect(seen[seen.length - 1].initialText).toBe('two\n')
  })
})
