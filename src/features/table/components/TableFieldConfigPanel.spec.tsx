// src/features/table/components/TableFieldConfigPanel.spec.tsx
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldConfigPanel } from './TableFieldConfigPanel'
import type { DataField } from '@/types/dataDocument'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

const baseField: DataField = {
  id: 1,
  user_id: 1,
  document_id: 1,
  table_id: 1,
  name: 'title',
  title: 'Title',
  description: '',
  type: 'text',
  required: false,
  readonly: false,
  is_primary: true,
  formula: '',
  ai_config: null,
  options: { column_tone: 'slate' },
  order: 0,
} as unknown as DataField

const secondField: DataField = { ...baseField, id: 2, name: 'desc', title: 'Desc', type: 'long_text', is_primary: false }
const dateField: DataField = {
  ...baseField,
  id: 3,
  name: 'received_at',
  title: 'Received At',
  type: 'datetime',
  is_primary: false,
  options: { date_format: 'year_month_day_time_slash' },
}

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

describe('FieldConfigPanel', () => {
  beforeEach(async () => { await unmount() })

  it('Save is disabled while no edits have been made', async () => {
    await mount(
      createElement(FieldConfigPanel, {
        field: baseField,
        fields: [baseField, secondField],
        busy: false,
        onClose: () => {},
        onSave: () => {},
      }),
    )
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const save = buttons.find((b) => b.textContent?.trim() === 'Save')
    expect(save?.disabled).toBe(true)
  })

  it('does not expose the legacy required-field switch', async () => {
    await mount(
      createElement(FieldConfigPanel, {
        field: { ...baseField, required: true },
        fields: [{ ...baseField, required: true }, secondField],
        busy: false,
        onClose: () => {},
        onSave: () => {},
      }),
    )

    expect(container.querySelector('[data-testid="field-required-switch"]')).toBeNull()
  })

  it('typing in name enables Save and calls onSave with new title', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    await mount(
      createElement(FieldConfigPanel, {
        field: baseField,
        fields: [baseField, secondField],
        busy: false,
        onClose,
        onSave,
      }),
    )
    const nameInput = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(nameInput, 'Renamed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const save = buttons.find((b) => b.textContent?.trim() === 'Save')!
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Renamed' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel with no edits closes immediately (no dialog)', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(FieldConfigPanel, {
        field: baseField,
        fields: [baseField, secondField],
        busy: false,
        onClose,
        onSave: () => {},
      }),
    )
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const cancel = buttons.find((b) => b.textContent?.trim() === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel after edit opens the dirty confirm dialog; Discard closes without save', async () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    await mount(
      createElement(FieldConfigPanel, {
        field: baseField,
        fields: [baseField, secondField],
        busy: false,
        onClose,
        onSave,
      }),
    )
    const nameInput = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(nameInput, 'Changed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    await act(async () => { buttons.find((b) => b.textContent?.trim() === 'Cancel')!.click() })
    const discard = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Discard',
    ) as HTMLButtonElement | undefined
    expect(discard).toBeDefined()
    await act(async () => { discard!.click() })
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('long_text shows Show as section; selecting Markdown saves options.showAs = "markdown"', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await mount(
      createElement(FieldConfigPanel, {
        field: secondField,
        fields: [baseField, secondField],
        busy: false,
        onClose: () => {},
        onSave,
      }),
    )
    const markdown = container.querySelector('[data-testid="field-show-as-markdown"]') as HTMLButtonElement | null
    expect(markdown).not.toBeNull()
    await act(async () => { markdown!.click() })
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const save = buttons.find((b) => b.textContent?.trim() === 'Save')!
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].options.showAs).toBe('markdown')
  })

  it('non-long_text fields do not render Show as section and save with showAs undefined', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await mount(
      createElement(FieldConfigPanel, {
        field: baseField,
        fields: [baseField, secondField],
        busy: false,
        onClose: () => {},
        onSave,
      }),
    )
    expect(container.querySelector('[data-testid="field-show-as-markdown"]')).toBeNull()
    const nameInput = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(nameInput, 'Renamed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const save = buttons.find((b) => b.textContent?.trim() === 'Save')!
    await act(async () => { save.click() })
    expect(onSave.mock.calls[0][0].options.showAs).toBeUndefined()
  })

  it('date fields save the selected display format in field options', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await mount(
      createElement(FieldConfigPanel, {
        field: dateField,
        fields: [baseField, dateField],
        busy: false,
        onClose: () => {},
        onSave,
      }),
    )

    const formatSelect = container.querySelector('select[data-testid="field-date-format"]') as HTMLSelectElement
    expect(formatSelect).not.toBeNull()
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      nativeSetter?.call(formatSelect, 'day_month_year_slash')
      formatSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const save = buttons.find((button) => button.textContent?.trim() === 'Save')!
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })

    expect(onSave.mock.calls[0][0].options.date_format).toBe('day_month_year_slash')
  })

  it('removes a legacy image customization size when saving field changes', async () => {
    const legacyImageField = {
      ...baseField,
      id: 4,
      name: 'thumbnail',
      title: 'Thumbnail',
      type: 'attachment',
      is_primary: false,
      ai_config: {
        type: 'image_customization',
        enabled: true,
        auto_update: true,
        source_field_id: secondField.id,
        prompt: 'Create a thumbnail for {{desc}}',
        size: '1792x1024',
        n: 3,
        quality: 'medium',
        aspect_ratio: '16:9',
        resolution: '1K',
        image_use_case: 'cover_illustration',
      },
    } as unknown as DataField
    const onSave = vi.fn().mockResolvedValue(undefined)
    await mount(
      createElement(FieldConfigPanel, {
        field: legacyImageField,
        fields: [secondField, legacyImageField],
        busy: false,
        onClose: () => {},
        onSave,
      }),
    )

    const nameInput = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(nameInput, 'Generated Thumbnail')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    ) as HTMLButtonElement
    await act(async () => { save.click() })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].options.ai_config).not.toHaveProperty('size')
  })
})
