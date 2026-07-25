import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageCustomizationForm } from './ImageCustomizationForm'
import type { AttachmentAIConfig, DataFieldAIImageUseCase } from '@/types/aiConfig'

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

const fields = [
  { id: 1, name: 'self', title: 'Self', type: 'attachment', is_primary: false, readonly: false, options: {} },
  { id: 2, name: 'src', title: 'Source image', type: 'attachment', is_primary: false, readonly: false, options: {} },
] as any

describe('ImageCustomizationForm', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('updates prompt', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Make it watercolor',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageCustomizationForm, {
        fields,
        currentFieldId: 1,
        value: config,
        onChange,
      }),
    )
    const textarea = container.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Make it cyberpunk')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Make it cyberpunk' }))
  })

  it('renders all 6 use case options', async () => {
    const onChange = vi.fn()
    const config: AttachmentAIConfig = {
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Make it watercolor',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageCustomizationForm, {
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
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Make it watercolor',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'product_showcase',
    }
    await mount(
      createElement(ImageCustomizationForm, {
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
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Make it watercolor',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    }
    await mount(
      createElement(ImageCustomizationForm, {
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
