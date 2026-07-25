import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIConfigPanel } from './AIConfigPanel'
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
  id: 1, name: 'self', title: 'Self', type: 'attachment',
  is_primary: false, readonly: false, options: {}, ...overrides,
}) as DataField

const fields: DataField[] = [
  baseField({ id: 1, type: 'attachment' }),
  baseField({ id: 2, name: 'desc', title: 'Description', type: 'long_text' }),
]

describe('AIConfigPanel', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders disabled state by default', async () => {
    await mount(createElement(AIConfigPanel, {
      field: fields[0],
      fields,
      value: undefined,
      onChange: () => {},
    }))
    const checkbox = container.querySelector('input[aria-label="Enable AI"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(false)
  })

  it('initializes default config when enabled', async () => {
    const onChange = vi.fn()
    await mount(createElement(AIConfigPanel, {
      field: fields[0],
      fields,
      value: undefined,
      onChange,
    }))
    const checkbox = container.querySelector('input[aria-label="Enable AI"]') as HTMLInputElement
    await act(async () => {
      checkbox.click()
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      type: 'image_generation',
    }))
  })

  it('switches action and resets to that action defaults', async () => {
    const onChange = vi.fn()
    await mount(createElement(AIConfigPanel, {
      field: fields[0],
      fields,
      value: {
        type: 'image_generation',
        enabled: true,
        auto_update: false,
        source_field_id: 2,
        n: 1,
        quality: 'medium',
        aspect_ratio: '1:1',
        resolution: '1K',
        image_use_case: 'inline_illustration',
      },
      onChange,
    }))
    const select = container.querySelector('select[aria-label="Action"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'image_customization'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      type: 'image_customization',
      enabled: true,
    }))
  })

  it('renders nothing for unsupported field type', async () => {
    await mount(createElement(AIConfigPanel, {
      field: baseField({ id: 1, type: 'number' }),
      fields,
      value: undefined,
      onChange: () => {},
    }))
    expect(container.firstChild).toBeNull()
  })
})
