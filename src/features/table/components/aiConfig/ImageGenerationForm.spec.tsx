import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageGenerationForm } from './ImageGenerationForm'
import type { AttachmentAIConfig, DataFieldAIImageUseCase } from '@/types/aiConfig'
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

const fields: DataField[] = [
  baseField({ id: 1, name: 'self', title: 'Self', type: 'attachment' }),
  baseField({ id: 2, name: 'desc', title: 'Description', type: 'long_text' }),
]

describe('ImageGenerationForm', () => {
  afterEach(async () => {
    await unmount()
  })

  it('renders current values and propagates onChange', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 2,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageGenerationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const options = container.querySelectorAll('option')
    const titles = Array.from(options).map((o) => o.textContent)
    expect(titles).toContain('Description')
    const aspectSelect = container.querySelector('select[aria-label="Aspect ratio"]') as HTMLSelectElement
    expect(aspectSelect).not.toBeNull()
    await act(async () => {
      aspectSelect.value = '16:9'
      aspectSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ aspect_ratio: '16:9' }))
  })

  it('updates source_field_id via picker', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 2,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageGenerationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const select = container.querySelector('select[role="combobox"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = '2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ source_field_id: 2 }))
  })

  it('renders all 6 use case options', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 2,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageGenerationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const useCaseSelect = container.querySelector('select[aria-label="Use case"]') as HTMLSelectElement
    expect(useCaseSelect).not.toBeNull()
    const optionValues = Array.from(useCaseSelect.options).map((o) => o.value)
    expect(optionValues).toEqual([
      'cover_illustration',
      'inline_illustration',
      'infographic_diagram',
      'product_showcase',
      'icon_brand',
      'other',
    ])
  })

  it('reflects config.image_use_case as the selected value', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 2,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'product_showcase',
    }
    await mount(
      createElement(ImageGenerationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const useCaseSelect = container.querySelector('select[aria-label="Use case"]') as HTMLSelectElement
    expect(useCaseSelect).not.toBeNull()
    expect(useCaseSelect.value).toBe('product_showcase')
  })

  it('calls onChange with updated image_use_case when selection changes', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 2,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageGenerationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const useCaseSelect = container.querySelector('select[aria-label="Use case"]') as HTMLSelectElement
    expect(useCaseSelect).not.toBeNull()
    await act(async () => {
      useCaseSelect.value = 'icon_brand'
      useCaseSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ image_use_case: 'icon_brand' as DataFieldAIImageUseCase }),
    )
  })
})
