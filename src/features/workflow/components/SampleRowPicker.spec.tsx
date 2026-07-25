import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SampleRowPicker, previewRecord } from './SampleRowPicker'

vi.mock('@/api/dataDocuments', () => ({
  listDataRecords: vi.fn(),
}))

import { listDataRecords } from '@/api/dataDocuments'

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listDataRecords).mockReset()
})
afterEach(() => {
  root?.unmount()
  container.remove()
})

describe('SampleRowPicker', () => {
  it('renders the trigger button labelled with the unbound state when no table is set', async () => {
    await mount(createElement(SampleRowPicker, {
      documentId: null,
      tableId: null,
      onPick: () => {},
    }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('No table bound')
  })

  it('enables the trigger button when both documentId and tableId are set', async () => {
    await mount(createElement(SampleRowPicker, {
      documentId: 7,
      tableId: 42,
      onPick: () => {},
    }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('Use existing row')
  })

  it('honours the disabled prop even when a table is bound', async () => {
    await mount(createElement(SampleRowPicker, {
      documentId: 1,
      tableId: 2,
      disabled: true,
      onPick: () => {},
    }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe('previewRecord', () => {
  it('picks the first non-empty string as the label and the second as the hint', () => {
    const out = previewRecord({
      id: 1,
      user_id: 1,
      document_id: 1,
      table_id: 1,
      row_key: 'r',
      order: 1,
      values: {
        name: 'Alice',
        email: 'alice@x.com',
        notes: 'whatever',
      },
      created_at: '',
      updated_at: '',
    } as any)
    expect(out.label).toBe('Alice')
    expect(out.hint).toBe('alice@x.com')
  })

  it('falls back to "Row #<id>" when no string columns are populated', () => {
    const out = previewRecord({
      id: 99,
      user_id: 1,
      document_id: 1,
      table_id: 1,
      row_key: 'r',
      order: 1,
      values: { count: 7, active: true },
      created_at: '',
      updated_at: '',
    } as any)
    expect(out.label).toBe('Row #99')
    expect(out.hint).toBe('')
  })

  it('skips empty / whitespace-only string values when picking the label', () => {
    const out = previewRecord({
      id: 1,
      user_id: 1,
      document_id: 1,
      table_id: 1,
      row_key: 'r',
      order: 1,
      values: {
        a: '   ',
        b: '',
        c: 'Real value',
      },
      created_at: '',
      updated_at: '',
    } as any)
    expect(out.label).toBe('Real value')
    expect(out.hint).toBe('')
  })
})
