import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddRecordActionPropertiesPanel } from './AddRecordActionPropertiesPanel'
import type { TableSchema } from './BodyTemplateEditor.types'
import type { TriggerTableOption } from './TriggerTableSelect'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

const TABLE_OPTIONS: TriggerTableOption[] = [
  { tableId: 't_users', tableName: 'Users', documentTitle: 'CRM' },
  { tableId: 't_leads', tableName: 'Leads', documentTitle: 'CRM' },
]

const USERS_SCHEMA: TableSchema = {
  id: 't_users',
  name: 'Users',
  fields: [
    { id: 'f_name', name: 'Name', type: 'text' },
    { id: 'f_email', name: 'Email', type: 'text' },
  ],
}

describe('AddRecordActionPropertiesPanel', () => {
  it('renders just the target picker when no target is selected', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: null,
      tableOptions: TABLE_OPTIONS,
      targetSchema: null,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange: () => {},
    }))
    expect(container.querySelector('[data-testid="add-record-target-table"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="add-record-field-rows"]')).toBeNull()
    expect(container.querySelector('[data-testid="add-record-field-rows-empty"]')).toBeNull()
  })

  it('renders a row per field once the target schema is loaded', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange: () => {},
    }))
    expect(container.querySelectorAll('[data-testid="body-template-editor"]').length).toBe(2)
  })

  it('shows the loading placeholder when target is picked but schema is still null', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: null,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange: () => {},
    }))
    const placeholder = container.querySelector('[data-testid="add-record-field-rows-empty"]')
    expect(placeholder?.textContent).toContain('Loading')
  })

  it('emits a wiped config when the target table changes', async () => {
    const onChange = vi.fn()
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: {
        targetTableId: 't_users',
        fields: [{ fieldId: 'f_name', value: { parts: [{ kind: 'text', text: 'hello' }] } }],
      },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange,
    }))
    // The picker is a Popover; click the trigger to open, then click a row.
    const trigger = container.querySelector('[data-testid="add-record-target-table"]') as HTMLButtonElement
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // Popover renders into document.body, not the local container.
    const rows = document.body.querySelectorAll('[role="option"]')
    const leadsRow = Array.from(rows).find((r) => r.textContent?.includes('Leads')) as HTMLElement
    await act(async () => { leadsRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onChange).toHaveBeenCalledWith({ targetTableId: 't_leads', fields: [] })
  })

  it('renders a panel-level error next to the target picker', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: null,
      tableOptions: TABLE_OPTIONS,
      targetSchema: null,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange: () => {},
      error: 'Pick a target table to enable this workflow',
    }))
    const err = container.querySelector('[data-testid="drawer-field-error"]')
    expect(err?.textContent).toContain('Pick a target table')
  })

  it('renders per-field errors next to the matching row', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange: () => {},
      fieldErrors: { f_email: 'Invalid email template' },
    }))
    const errs = container.querySelectorAll('[data-testid="drawer-field-error"]')
    const messages = Array.from(errs).map((e) => e.textContent || '')
    expect(messages.some((m) => m.includes('Invalid email template'))).toBe(true)
  })

  it('updates the matching field entry when a row is edited', async () => {
    const onChange = vi.fn()
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      onChange,
    }))
    // The first editor's "Add text" toolbar button appends a text part —
    // exercise it as a proxy for the editor's onChange wiring without
    // coupling this test to the editor's internal markup.
    const editors = container.querySelectorAll('[data-testid="body-template-editor"]')
    const addText = editors[0].querySelector('[data-testid="body-add-text"]') as HTMLButtonElement
    await act(async () => { addText.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // After clicking "Add text", the editor calls onChange with a
    // [{kind:'text', text:''}] part — the panel forwards it as a row update.
    expect(onChange).toHaveBeenCalledWith({
      targetTableId: 't_users',
      fields: [{ fieldId: 'f_name', value: { parts: [{ kind: 'text', text: '' }] } }],
    })
  })

  it('renders an amber loop warning when target table matches the trigger table', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      triggerTableId: 't_users',
      onChange: () => {},
    }))
    const warn = container.querySelector('[data-testid="add-record-loop-warning"]')
    expect(warn).not.toBeNull()
    expect(warn?.textContent).toContain('Writing to the trigger table')
  })

  it('does not render the loop warning when target differs from trigger', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      triggerTableId: 't_leads',
      onChange: () => {},
    }))
    expect(container.querySelector('[data-testid="add-record-loop-warning"]')).toBeNull()
  })

  it('does not render the loop warning when trigger has no table (scheduled_time)', async () => {
    await mount(createElement(AddRecordActionPropertiesPanel, {
      config: { targetTableId: 't_users', fields: [] },
      tableOptions: TABLE_OPTIONS,
      targetSchema: USERS_SCHEMA,
      sourceSchema: null,
      sourceNodeId: 'trigger_1',
      sourceNodeTitle: '1. Trigger',
      triggerTableId: undefined,
      onChange: () => {},
    }))
    expect(container.querySelector('[data-testid="add-record-loop-warning"]')).toBeNull()
  })
})
