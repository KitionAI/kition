import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Menu } from './Menu'
import { MenuRenderer } from './MenuRenderer'

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
  if (!root) return
  await act(async () => {
    root!.unmount()
  })
  container?.remove()
  root = null
}

describe('MenuRenderer', () => {
  afterEach(async () => {
    await unmount()
  })

  it('renders items, separators, and shortcuts', async () => {
    const menu = new Menu()
    menu
      .addItem((i) => i.setTitle('Add link').setIcon('link'))
      .addSeparator()
      .addItem((i) => i.setTitle('Bold').setShortcut('Cmd+B'))
      .addItem((i) => i.setTitle('Paste').setDisabled(true))

    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 100, y: 100 },
        onClose: () => {},
      }),
    )

    const items = container.querySelectorAll('.document-menu-item')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('Add link')
    expect(items[1].textContent).toContain('Bold')
    expect(items[1].querySelector('kbd')?.textContent).toBe('Cmd+B')
    expect(items[2].classList.contains('is-disabled')).toBe(true)
    expect(container.querySelectorAll('.document-menu-separator')).toHaveLength(1)
  })

  it('renders submenu arrow when item has submenu', async () => {
    const menu = new Menu()
    menu.addItem((i) => {
      i.setTitle('Text format')
      i.setSubmenu().addItem((s) => s.setTitle('Bold'))
    })

    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose: () => {},
      }),
    )

    expect(container.querySelector('.document-menu-item .document-menu-submenu-arrow')).not.toBeNull()
  })
})

describe('MenuRenderer dismiss', () => {
  afterEach(async () => {
    await unmount()
  })

  it('calls onClose on outside mousedown', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
      }),
    )
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
      }),
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when clicking inside the menu', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
      }),
    )
    const inner = container.querySelector('.document-menu')!
    await act(async () => {
      inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips listeners on submenu instances', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
        isSubmenu: true,
      }),
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on window resize', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
      }),
    )
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on scroll (capture phase)', async () => {
    const onClose = vi.fn()
    const menu = new Menu().addItem((i) => i.setTitle('X'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 0, y: 0 },
        onClose,
      }),
    )
    await act(async () => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MenuRenderer positioning', () => {
  let originalOffsetWidth: PropertyDescriptor | undefined
  let originalOffsetHeight: PropertyDescriptor | undefined
  let originalInnerWidth: number
  let originalInnerHeight: number

  beforeEach(() => {
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    originalInnerWidth = window.innerWidth
    originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 100 })
  })

  afterEach(async () => {
    await unmount()
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
    else delete (HTMLElement.prototype as any).offsetWidth
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    else delete (HTMLElement.prototype as any).offsetHeight
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  })

  it('shifts left when menu would overflow the right edge', async () => {
    const menu = new Menu().addItem((i) => i.setTitle('Item'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 780, y: 100 },
        onClose: () => {},
      }),
    )
    const root = container.querySelector('.document-menu') as HTMLElement
    // innerWidth(800) - width(200) - margin(8) = 592
    expect(parseFloat(root.style.left)).toBe(592)
  })

  it('shifts up when menu would overflow the bottom edge', async () => {
    const menu = new Menu().addItem((i) => i.setTitle('Item'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: 100, y: 580 },
        onClose: () => {},
      }),
    )
    const root = container.querySelector('.document-menu') as HTMLElement
    expect(parseFloat(root.style.top)).toBe(492) // 600 - 100 - 8
  })

  it('clamps to margin when position is negative', async () => {
    const menu = new Menu().addItem((i) => i.setTitle('Item'))
    await mount(
      createElement(MenuRenderer, {
        menu,
        position: { x: -50, y: -50 },
        onClose: () => {},
      }),
    )
    const root = container.querySelector('.document-menu') as HTMLElement
    expect(parseFloat(root.style.left)).toBe(8)
    expect(parseFloat(root.style.top)).toBe(8)
  })

  it('opens submenu on right of parent by default', async () => {
    const submenu = new Menu().addItem((i) => i.setTitle('S'))
    const parentRect = {
      left: 100, right: 250, top: 100, bottom: 130, width: 150, height: 30, x: 100, y: 100,
      toJSON: () => ({}),
    } as DOMRect
    await mount(
      createElement(MenuRenderer, {
        menu: submenu,
        position: { x: 250, y: 100 },
        onClose: () => {},
        parentRect,
        isSubmenu: true,
      }),
    )
    const root = container.querySelector('.document-menu') as HTMLElement
    expect(parseFloat(root.style.left)).toBe(250) // parentRect.right
    expect(parseFloat(root.style.top)).toBe(100) // parentRect.top
  })

  it('flips submenu to left when right side overflows', async () => {
    const submenu = new Menu().addItem((i) => i.setTitle('S'))
    // parent on right edge: right=750, plus submenu width 200 + margin 8 = 958 > 800 → flip
    const parentRect = {
      left: 600, right: 750, top: 100, bottom: 130, width: 150, height: 30, x: 600, y: 100,
      toJSON: () => ({}),
    } as DOMRect
    await mount(
      createElement(MenuRenderer, {
        menu: submenu,
        position: { x: 750, y: 100 },
        onClose: () => {},
        parentRect,
        isSubmenu: true,
      }),
    )
    const root = container.querySelector('.document-menu') as HTMLElement
    expect(parseFloat(root.style.left)).toBe(400) // parentRect.left - width = 600 - 200
  })
})
