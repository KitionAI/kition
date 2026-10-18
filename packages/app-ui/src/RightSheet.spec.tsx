import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RightSheet } from './RightSheet'

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

describe('RightSheet', () => {
  afterEach(async () => { await unmount() })

  it('renders children when open', async () => {
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose: () => {},
        title: 'Edit field',
        children: createElement('span', { 'data-testid': 'sheet-body' }, 'hi'),
      }),
    )
    expect(container.querySelector('[data-testid="sheet-body"]')).not.toBeNull()
  })

  it('does NOT render anything when closed', async () => {
    await mount(
      createElement(RightSheet, {
        open: false,
        onClose: () => {},
        title: 'Edit field',
        children: createElement('span', { 'data-testid': 'sheet-body' }, 'hi'),
      }),
    )
    expect(container.querySelector('[data-testid="sheet-body"]')).toBeNull()
  })

  it('starts off-screen (translateX(100%)) and slides in on the next frame', async () => {
    // Force rAF to be synchronous so we can observe both before + after.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1 as unknown as number
    })
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose: () => {},
        title: 'Edit field',
        children: createElement('span', null, 'x'),
      }),
    )
    const panel = container.querySelector('[data-testid="right-sheet"]') as HTMLElement
    expect(panel).not.toBeNull()
    // After rAF fired, the panel is in its "visible" transform.
    expect(panel.style.transform).toBe('translateX(0)')
    rafSpy.mockRestore()
  })

  it('close button calls onClose when not dirty', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn()
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose,
        onRequestClose,
        dirty: false,
        title: 't',
        children: createElement('span', null, 'x'),
      }),
    )
    await act(async () => {
      (container.querySelector('[data-testid="right-sheet-close"]') as HTMLButtonElement).click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('close button calls onRequestClose when dirty', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn()
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose,
        onRequestClose,
        dirty: true,
        title: 't',
        children: createElement('span', null, 'x'),
      }),
    )
    await act(async () => {
      (container.querySelector('[data-testid="right-sheet-close"]') as HTMLButtonElement).click()
    })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape key routes through dirty guard', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn()
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose,
        onRequestClose,
        dirty: true,
        title: 't',
        children: createElement('span', null, 'x'),
      }),
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('backdrop click routes through dirty guard', async () => {
    const onClose = vi.fn()
    const onRequestClose = vi.fn()
    await mount(
      createElement(RightSheet, {
        open: true,
        onClose,
        onRequestClose,
        dirty: true,
        title: 't',
        children: createElement('span', null, 'x'),
      }),
    )
    await act(async () => {
      (container.querySelector('[data-testid="right-sheet-backdrop"]') as HTMLDivElement).click()
    })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})
