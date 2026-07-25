import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceFieldPicker } from './sourceFieldPicker'
import type { DataField } from '@/types/dataDocument'

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
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

const baseField = (overrides: Partial<DataField>): DataField => ({
  id: 1,
  name: 'col',
  title: 'Col',
  type: 'text',
  is_primary: false,
  readonly: false,
  options: {},
  ...overrides,
}) as DataField

describe('SourceFieldPicker', () => {
  afterEach(async () => {
    await unmount()
  })

  it('lists fields excluding the current field', async () => {
    const fields: DataField[] = [
      baseField({ id: 1, name: 'self', title: 'Self', type: 'text' }),
      baseField({ id: 2, name: 'desc', title: 'Description', type: 'long_text' }),
      baseField({ id: 3, name: 'img', title: 'Image', type: 'attachment' }),
    ]
    await mount(
      createElement(SourceFieldPicker, {
        fields,
        currentFieldId: 1,
        value: 2,
        onChange: () => {},
      }),
    )
    const options = container.querySelectorAll('option')
    const titles = Array.from(options).map((o) => o.textContent)
    expect(titles).toContain('Description')
    expect(titles).not.toContain('Self')
  })

  it('calls onChange with field id on selection', async () => {
    const onChange = vi.fn()
    const fields: DataField[] = [
      baseField({ id: 1, name: 'self', title: 'Self', type: 'text' }),
      baseField({ id: 2, name: 'desc', title: 'Description', type: 'long_text' }),
    ]
    await mount(
      createElement(SourceFieldPicker, {
        fields,
        currentFieldId: 1,
        value: null,
        onChange,
      }),
    )
    const select = container.querySelector('select') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = '2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(2)
  })
})
