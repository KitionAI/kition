import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useDialogFocus } from './useDialogFocus'

function Dialog({ withControls = true }: { withControls?: boolean }) {
  const ref = useDialogFocus<HTMLDivElement>()
  return createElement(
    'div',
    { ref, role: 'dialog', tabIndex: -1, 'data-testid': 'dialog' },
    withControls ? createElement('button', { 'data-testid': 'first' }, 'First') : null,
    withControls ? createElement('input', { 'data-testid': 'middle' }) : null,
    withControls ? createElement('button', { 'data-testid': 'last' }, 'Last') : null,
  )
}

function DialogWithPreferredFocus() {
  const ref = useDialogFocus<HTMLDivElement>()
  return createElement(
    'div',
    { ref, role: 'dialog', tabIndex: -1, 'data-testid': 'dialog' },
    createElement('button', { 'data-testid': 'close' }, 'Close'),
    createElement('input', { 'data-testid': 'search', 'data-dialog-initial-focus': true }),
  )
}

let container: HTMLDivElement
let trigger: HTMLButtonElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  trigger = document.createElement('button')
  document.body.append(trigger, container)
  trigger.focus()
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container.remove()
  trigger.remove()
})

function tab(target: Element, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
}

describe('useDialogFocus', () => {
  it('moves focus in on mount, wraps Tab at both ends, and restores focus on unmount', async () => {
    await act(async () => root!.render(createElement(Dialog)))
    const first = container.querySelector('[data-testid="first"]') as HTMLElement
    const last = container.querySelector('[data-testid="last"]') as HTMLElement
    expect(document.activeElement).toBe(first)

    last.focus()
    tab(last)
    expect(document.activeElement).toBe(first)
    tab(first, true)
    expect(document.activeElement).toBe(last)

    await act(async () => root!.render(createElement('div')))
    expect(document.activeElement).toBe(trigger)
  })

  it('moves Tab through every control itself, buttons included, as WebKit would not', async () => {
    await act(async () => root!.render(createElement(Dialog)))
    const first = container.querySelector('[data-testid="first"]') as HTMLElement
    const middle = container.querySelector('[data-testid="middle"]') as HTMLElement
    const last = container.querySelector('[data-testid="last"]') as HTMLElement
    tab(first)
    expect(document.activeElement).toBe(middle)
    tab(middle)
    expect(document.activeElement).toBe(last)
    tab(last, true)
    expect(document.activeElement).toBe(middle)
  })

  it('leaves a Tab an editor inside the dialog already handled', async () => {
    await act(async () => root!.render(createElement(Dialog)))
    const middle = container.querySelector('[data-testid="middle"]') as HTMLElement
    middle.focus()
    middle.addEventListener('keydown', (event) => event.preventDefault())
    tab(middle)
    expect(document.activeElement).toBe(middle)
  })

  it('focuses the element marked data-dialog-initial-focus instead of the first tabbable one', async () => {
    await act(async () => root!.render(createElement(DialogWithPreferredFocus)))
    const search = container.querySelector('[data-testid="search"]') as HTMLElement
    expect(document.activeElement).toBe(search)
  })

  it('focuses the container itself when it has no controls', async () => {
    await act(async () => root!.render(createElement(Dialog, { withControls: false })))
    const dialog = container.querySelector('[data-testid="dialog"]') as HTMLElement
    expect(document.activeElement).toBe(dialog)
    tab(dialog)
    expect(document.activeElement).toBe(dialog)
  })
})
