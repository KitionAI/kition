import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TextGenerationForm } from './TextGenerationForm'
import { SummarizeForm } from './SummarizeForm'
import { ExtractForm } from './ExtractForm'
import { TranslateForm } from './TranslateForm'
import { ClassifyForm } from './ClassifyForm'
import { CustomizeForm } from './CustomizeForm'
import type { TextAIConfig } from '@/types/aiConfig'

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
  { id: 1, name: 'self', title: 'Self', type: 'text', is_primary: false, readonly: false, options: {} },
  { id: 2, name: 'src', title: 'Source', type: 'long_text', is_primary: false, readonly: false, options: {} },
] as any

describe('text action forms', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('TextGenerationForm updates prompt', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'text_generation', enabled: true, auto_update: false, prompt: '' }
    await mount(createElement(TextGenerationForm, { value, onChange }))
    const textarea = container.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'hi')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hi' }))
  })

  it('SummarizeForm updates max_words', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'summarize', enabled: true, auto_update: false, source_field_id: 2 }
    await mount(createElement(SummarizeForm, { fields, currentFieldId: 1, value, onChange }))
    const input = container.querySelector('input[aria-label="Max words"]') as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '50')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ max_words: 50 }))
  })

  it('ExtractForm updates schema', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'extract', enabled: true, auto_update: false, source_field_id: 2 }
    await mount(createElement(ExtractForm, { fields, currentFieldId: 1, value, onChange }))
    const textarea = container.querySelector('textarea[aria-label="Schema"]') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '{"x":1}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ schema: '{"x":1}' }))
  })

  it('TranslateForm updates target_language', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'translate', enabled: true, auto_update: false, source_field_id: 2, target_language: 'en' }
    await mount(createElement(TranslateForm, { fields, currentFieldId: 1, value, onChange }))
    const select = container.querySelector('select[aria-label="Target language"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = 'ja'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target_language: 'ja' }))
  })

  it('ClassifyForm parses categories from textarea', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'classify', enabled: true, auto_update: false, source_field_id: 2, categories: ['a', 'b'] }
    await mount(createElement(ClassifyForm, { fields, currentFieldId: 1, value, onChange }))
    const textarea = container.querySelector('textarea[aria-label="Categories"]') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'high\nmedium\nlow')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ categories: ['high', 'medium', 'low'] }))
  })

  it('CustomizeForm updates prompt', async () => {
    const onChange = vi.fn()
    const value: TextAIConfig = { type: 'customize', enabled: true, auto_update: false, prompt: '' }
    await mount(createElement(CustomizeForm, { value, onChange }))
    const textarea = container.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'hi {{x}}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hi {{x}}' }))
  })
})
