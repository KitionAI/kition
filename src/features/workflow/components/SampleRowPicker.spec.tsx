import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SampleRowPicker, previewRecord } from './SampleRowPicker'

vi.mock('@/api/kitTables', () => ({
  listTableRecords: vi.fn(),
}))

import { listTableRecords } from '@/api/kitTables'

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
  vi.mocked(listTableRecords).mockReset()
})
afterEach(() => {
  root?.unmount()
  container.remove()
})

describe('SampleRowPicker', () => {
  it('renders the trigger button labelled with the unbound state when no table is set', async () => {
    await mount(createElement(SampleRowPicker, {
      documentPath: null,
      tableId: null,
      onPick: () => {},
    }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('No table bound')
  })

  it('enables the trigger button when both documentPath and tableId are set', async () => {
    await mount(createElement(SampleRowPicker, {
      documentPath: 'crm.ktable',
      tableId: '1',
      onPick: () => {},
    }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('Use existing row')
  })

  it('lists the bound table\'s records through the Table kit and hands back the picked one', async () => {
    vi.mocked(listTableRecords).mockResolvedValue({ items: [{ id: 5, values: { name: 'Ann' } }], total: 1 })
    const onPick = vi.fn()
    await mount(createElement(SampleRowPicker, { documentPath: 'crm.ktable', tableId: '1', onPick }))
    const btn = container.querySelector('[data-testid="workflow-home-sample-row-picker"]') as HTMLButtonElement
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })
    expect(listTableRecords).toHaveBeenCalledWith({ path: 'crm.ktable', tableId: '1' }, { limit: 10 })
    const option = document.querySelector('[data-testid="workflow-home-sample-row-option"]') as HTMLButtonElement
    expect(option?.getAttribute('data-record-id')).toBe('5')
    await act(async () => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onPick).toHaveBeenCalledWith({ name: 'Ann' }, { id: 5, values: { name: 'Ann' } })
  })

  it('honours the disabled prop even when a table is bound', async () => {
    await mount(createElement(SampleRowPicker, {
      documentPath: 'crm.ktable',
      tableId: '2',
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
      values: {
        name: 'Alice',
        email: 'alice@x.com',
        notes: 'whatever',
      },
    })
    expect(out.label).toBe('Alice')
    expect(out.hint).toBe('alice@x.com')
  })

  it('falls back to "Row #<id>" when no string columns are populated', () => {
    const out = previewRecord({
      id: 99,
      values: { count: 7, active: true },
    })
    expect(out.label).toBe('Row #99')
    expect(out.hint).toBe('')
  })

  it('skips empty / whitespace-only string values when picking the label', () => {
    const out = previewRecord({
      id: 1,
      values: {
        a: '   ',
        b: '',
        c: 'Real value',
      },
    })
    expect(out.label).toBe('Real value')
    expect(out.hint).toBe('')
  })
})
