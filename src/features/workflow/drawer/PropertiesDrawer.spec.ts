import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PropertiesDrawer, DrawerSection, DrawerField } from './PropertiesDrawer'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(element)
    await Promise.resolve()
  })
}

describe('PropertiesDrawer', () => {
  it('renders a hidden marker when closed so the canvas can take full width', async () => {
    await mount(
      createElement(PropertiesDrawer, { open: false, title: 'noop', onClose: () => {}, children: 'body' }),
    )
    const drawer = container.querySelector('[data-testid="workflow-properties-drawer"]')
    expect(drawer?.getAttribute('data-state')).toBe('closed')
  })

  it('renders the kind pill + title + body when open and fires onClose on the X button', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(PropertiesDrawer, {
        open: true,
        kind: 'Action',
        title: 'Send email',
        onClose,
        children: createElement(
          DrawerSection,
          { title: 'Email', children: createElement(DrawerField, { label: 'Subject', children: 'Hi there' }) },
        ),
      }),
    )
    const drawer = container.querySelector('[data-testid="workflow-properties-drawer"]')!
    expect(drawer.getAttribute('data-state')).toBe('open')
    expect(drawer.textContent).toContain('Action')
    expect(drawer.textContent).toContain('Send email')
    expect(drawer.textContent).toContain('Subject')
    const closeBtn = container.querySelector('[data-testid="workflow-properties-drawer-close"]') as HTMLButtonElement
    await act(async () => {
      closeBtn.click()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('DrawerField surfaces an error message with a stable test hook', async () => {
    await mount(
      createElement(PropertiesDrawer, {
        open: true,
        title: 'x',
        onClose: () => {},
        children: createElement(DrawerField, {
          label: 'To',
          error: 'Recipient is required',
          children: createElement('input'),
        }),
      }),
    )
    const err = container.querySelector('[data-testid="drawer-field-error"]')
    expect(err?.textContent).toBe('Recipient is required')
  })

  it('Esc pressed inside the drawer fires onClose (and stops propagation)', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(PropertiesDrawer, {
        open: true,
        title: 'x',
        onClose,
        children: 'body',
      }),
    )
    const drawer = container.querySelector('[data-testid="workflow-properties-drawer"]')!
    await act(async () => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      drawer.dispatchEvent(ev)
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focuses the close button on open and restores the previous focus on close', async () => {
    // Seed a trigger element that has focus when the drawer mounts.
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'before')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await mount(
      createElement(PropertiesDrawer, { open: true, title: 'x', onClose: () => {}, children: 'body' }),
    )
    // Focus management defers to the next tick so the close button is mounted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const closeBtn = container.querySelector('[data-testid="workflow-properties-drawer-close"]') as HTMLButtonElement
    expect(document.activeElement).toBe(closeBtn)

    // Close the drawer; the trigger should regain focus.
    await act(async () => {
      root!.render(
        createElement(PropertiesDrawer, { open: false, title: 'x', onClose: () => {}, children: 'body' }),
      )
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(trigger)

    trigger.remove()
  })
})
