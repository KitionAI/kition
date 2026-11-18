import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RightDrawer } from './RightDrawer'

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
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

async function rerender(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root!.render(node)
    await Promise.resolve()
  })
}

describe('RightDrawer', () => {
  afterEach(async () => {
    await unmount()
  })

  it('renders children when open', async () => {
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        children: createElement('span', { 'data-testid': 'drawer-body' }, 'hello'),
      }),
    )
    expect(container.querySelector('[data-testid="drawer-body"]')).not.toBeNull()
  })

  it('does NOT render children when closed', async () => {
    await mount(
      createElement(RightDrawer, {
        open: false,
        onClose: () => {},
        children: createElement('span', { 'data-testid': 'drawer-body' }, 'hello'),
      }),
    )
    expect(container.querySelector('[data-testid="drawer-body"]')).toBeNull()
  })

  it('calls onClose when × button is clicked', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose,
        children: createElement('span', null, 'x'),
      }),
    )
    const closeBtn = container.querySelector(
      '[data-testid="right-drawer-close"]',
    ) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => {
      closeBtn.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders a drag handle with the right test id', async () => {
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        children: createElement('span', null, 'x'),
      }),
    )
    expect(
      container.querySelector('[data-testid="right-drawer-resize-handle"]'),
    ).not.toBeNull()
  })

  it('renders a title when provided', async () => {
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        title: 'My Title',
        children: createElement('span', null, 'x'),
      }),
    )
    expect(
      container.querySelector('[data-testid="right-drawer-title"]')?.textContent,
    ).toBe('My Title')
  })

  it('applies the default width of 380px', async () => {
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        children: createElement('span', null, 'x'),
      }),
    )
    const drawer = container.querySelector(
      '[data-testid="right-drawer"]',
    ) as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.style.width).toBe('380px')
  })

  it('renders with initial translateX(100%) and flips to translateX(0) after a frame', async () => {
    // Mount without advancing rAF — initial state should be off-screen.
    container = document.createElement('div')
    document.body.appendChild(container)
    let capturedInitialTransform: string | undefined
    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(RightDrawer, {
          open: true,
          onClose: () => {},
          children: createElement('span', null, 'x'),
        }),
      )
      // Flush React's synchronous work but NOT any rAF callbacks.
      await Promise.resolve()
    })
    const drawer = container.querySelector('[data-testid="right-drawer"]') as HTMLElement
    capturedInitialTransform = drawer?.style.transform
    expect(capturedInitialTransform).toBe('translateX(100%)')

    // Advance one animation frame so the rAF callback fires → visible = true.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(drawer.style.transform).toBe('translateX(0)')
  })

  it('applies the explicit width prop', async () => {
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        width: 500,
        children: createElement('span', null, 'x'),
      }),
    )
    const drawer = container.querySelector(
      '[data-testid="right-drawer"]',
    ) as HTMLElement
    expect(drawer.style.width).toBe('500px')
  })

  it('clamps width between min (280) and max (800) when dragged', async () => {
    const onResize = vi.fn()
    await mount(
      createElement(RightDrawer, {
        open: true,
        onClose: () => {},
        onResize,
        width: 380,
        children: createElement('span', null, 'x'),
      }),
    )
    const handle = container.querySelector(
      '[data-testid="right-drawer-resize-handle"]',
    ) as HTMLElement

    Object.defineProperty(window, 'innerWidth', {
      value: 1000,
      configurable: true,
    })

    // jsdom does not implement PointerEvent — fake it via MouseEvent and
    // re-type it for the handler. The fields we read (clientX, preventDefault)
    // are present on both.
    function pointerEvent(type: string, init: { clientX: number } = { clientX: 0 }) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clientX', {
        value: init.clientX,
        configurable: true,
      })
      return event
    }

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500 }))
    })

    // Drag far left: width = innerWidth - clientX = 1000 - 50 = 950 → clamp to 800
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 50 }))
    })
    expect(onResize).toHaveBeenLastCalledWith(800)

    // Drag far right: width = 1000 - 950 = 50 → clamp to 280
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 950 }))
    })
    expect(onResize).toHaveBeenLastCalledWith(280)

    // Release
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointerup'))
    })
  })
})
