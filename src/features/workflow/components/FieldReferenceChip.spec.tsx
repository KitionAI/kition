import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FieldReferenceChip } from './FieldReferenceChip'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('FieldReferenceChip', () => {
  it('renders node title + field icon + field name', async () => {
    await mount(createElement(FieldReferenceChip, {
      nodeTitle: '1. When record...', fieldName: 'First Name', fieldType: 'text',
    }))
    expect(container.textContent).toContain('1. When record...')
    expect(container.textContent).toContain('T')
    expect(container.textContent).toContain('First Name')
  })

  it('uses ? for unknown field type', async () => {
    await mount(createElement(FieldReferenceChip, { nodeTitle: 'n', fieldName: 'f', fieldType: 'weird' }))
    expect(container.textContent).toContain('?')
  })
})
