import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentPropertiesDialog, type DocumentPropertiesDialogProps } from './DocumentPropertiesDialog'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

async function render(props: DocumentPropertiesDialogProps) {
  await act(async () => {
    root ??= createRoot(container)
    root.render(createElement(DocumentPropertiesDialog, props))
    await Promise.resolve()
  })
}

function inputs() {
  return [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
}

/** Types `value` into a React-controlled input. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function saveButton() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
  return buttons[buttons.length - 1]
}

describe('DocumentPropertiesDialog', () => {
  it('keeps the person’s edits when the document changes while it is open, and answers the text it opened on', async () => {
    const opened = '---\ntitle: Plan\nstatus: draft\n---\n\nBody\n'
    const onApply = vi.fn()
    const props = { open: true, onOpenChange: vi.fn(), source: opened, onApply }
    await render(props)
    const titleValue = inputs()[1]
    expect(titleValue.value).toBe('Plan')
    await typeInto(titleValue, 'Roadmap')

    // A file change merged meanwhile (another writer changed the status and the body).
    await render({ ...props, source: '---\ntitle: Plan\nstatus: done\n---\n\nBody\nMore\n' })
    expect(inputs()[1].value).toBe('Roadmap')

    await act(async () => {
      saveButton().click()
    })
    expect(onApply).toHaveBeenCalledTimes(1)
    const [base, next] = onApply.mock.calls[0]
    // The result is made from the text the dialog opened on, which the caller merges three-way.
    expect(base).toBe(opened)
    expect(next).toBe('---\ntitle: Roadmap\nstatus: draft\n---\n\nBody\n')
  })

  it('reads the current text again when it is opened again', async () => {
    const onApply = vi.fn()
    const props = { open: true, onOpenChange: vi.fn(), source: '---\ntitle: One\n---\n', onApply }
    await render(props)
    await render({ ...props, open: false, source: '---\ntitle: Two\n---\n' })
    await render({ ...props, open: true, source: '---\ntitle: Two\n---\n' })
    expect(inputs()[1].value).toBe('Two')
  })
})
