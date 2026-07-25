import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BodyTemplateEditor } from './BodyTemplateEditor'
import type { FieldSchema, TableSchema, BodyTemplate } from './BodyTemplateEditor.types'

let container: HTMLDivElement; let root: Root | null = null
async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

const schema: TableSchema = { id: 'tbl', name: 'Leads', fields: [
  { id: 'fld_a', name: 'First Name', type: 'text' },
  { id: 'fld_b', name: 'Last Name', type: 'text' },
] as FieldSchema[] }

const triggerNodeTitle = '1. When record created'

describe('BodyTemplateEditor', () => {
  it('renders interleaved text + chips + newlines', async () => {
    const tpl: BodyTemplate = { parts: [
      { kind: 'text', text: 'Hi ' },
      { kind: 'field_ref', fieldRef: { nodeId: 't', fieldId: 'fld_a' } },
      { kind: 'newline' },
      { kind: 'text', text: 'Email: ' },
      { kind: 'field_ref', fieldRef: { nodeId: 't', fieldId: 'fld_b' } },
    ] }
    await mount(createElement(BodyTemplateEditor, { template: tpl, triggerNodeTitle, schema, readOnly: true }))
    const chips = container.querySelectorAll('[data-testid="field-ref-chip"]')
    expect(chips.length).toBe(2)
    expect(container.textContent).toContain('Hi')
    expect(container.textContent).toContain('Email:')
  })

  it('renders unknown field as ghost chip with warning marker', async () => {
    const tpl: BodyTemplate = { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 't', fieldId: 'fld_ghost' } }] }
    await mount(createElement(BodyTemplateEditor, { template: tpl, triggerNodeTitle, schema, readOnly: true }))
    expect(container.querySelector('[data-testid="field-ref-missing"]')).not.toBeNull()
  })
})
