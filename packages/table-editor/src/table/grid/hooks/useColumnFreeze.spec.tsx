import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COLUMN_FREEZE_HOVER_DELAY_MS,
  useDelayedColumnFreezeHover,
} from './useColumnFreeze'

let container: HTMLDivElement
let root: Root | null = null

function HookSurface({ hovered, freezing }: { hovered: boolean; freezing: boolean }) {
  const visible = useDelayedColumnFreezeHover(hovered, freezing)
  return createElement('span', { 'data-visible': String(visible) })
}

function render(hovered: boolean, freezing: boolean) {
  act(() => {
    root ??= createRoot(container)
    root.render(createElement(HookSurface, { hovered, freezing }))
  })
}

function readVisible() {
  return container.querySelector('span')?.getAttribute('data-visible')
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useDelayedColumnFreezeHover', () => {
  it('waits 200ms before showing hover feedback and hides immediately on leave', async () => {
    render(false, false)
    render(true, false)

    expect(readVisible()).toBe('false')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLUMN_FREEZE_HOVER_DELAY_MS - 1)
    })
    expect(readVisible()).toBe('false')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(readVisible()).toBe('true')

    render(false, false)
    expect(readVisible()).toBe('false')
  })

  it('shows immediately while the freeze handle is being dragged', () => {
    render(false, true)
    expect(readVisible()).toBe('true')
  })

  it('restores the hover delay after dragging ends', async () => {
    render(true, true)
    expect(readVisible()).toBe('true')

    render(true, false)
    expect(readVisible()).toBe('false')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLUMN_FREEZE_HOVER_DELAY_MS)
    })
    expect(readVisible()).toBe('true')
  })
})
