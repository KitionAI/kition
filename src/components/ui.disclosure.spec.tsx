import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import { Disclosure } from './ui'

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

describe('Disclosure', () => {
  beforeEach(async () => { await unmount() })

  it('hides children by default and reveals them after clicking the trigger', async () => {
    await mount(
      createElement(Disclosure, { title: 'Advanced' },
        createElement('span', { 'data-testid': 'body' }, 'hi')),
    )
    expect(container.querySelector('[data-testid="body"]')).toBeNull()

    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { trigger.click() })
    expect(container.querySelector('[data-testid="body"]')).not.toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('respects defaultOpen', async () => {
    await mount(
      createElement(Disclosure, { title: 'Advanced', defaultOpen: true },
        createElement('span', { 'data-testid': 'body' }, 'hi')),
    )
    expect(container.querySelector('[data-testid="body"]')).not.toBeNull()
  })
})
