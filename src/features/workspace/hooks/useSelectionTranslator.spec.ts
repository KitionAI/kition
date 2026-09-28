import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/models', () => ({ chatWithModel: vi.fn() }))

import { chatWithModel } from '@/api/models'
import { TranslationAccountNotReadyError, TranslationModelMissingError, type DocumentTranslateText } from '@/features/document/public'
import type { RuntimeWritingModel } from '@/types'

import { useSelectionTranslator } from './useSelectionTranslator'

const runtimeModel: RuntimeWritingModel = {
  provider_type: 'openai',
  provider_label: 'OpenAI',
  model_name: 'example-model',
  base_url: 'https://api.example.com/v1',
  api_key: 'test-key',
}

let container: HTMLDivElement
let root: Root | null = null

async function mountTranslator(options: Parameters<typeof useSelectionTranslator>[0]) {
  let translate: DocumentTranslateText | null = null
  function Harness() {
    const value = useSelectionTranslator(options)
    useEffect(() => { translate = value }, [value])
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  return translate!
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(chatWithModel).mockReset()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  container.remove()
})

describe('useSelectionTranslator', () => {
  it('rejects with a typed error when no model is selected', async () => {
    const translate = await mountTranslator({ model: null })
    await expect(translate('Hello', 'fr', new AbortController().signal)).rejects.toBeInstanceOf(TranslationModelMissingError)
    expect(chatWithModel).not.toHaveBeenCalled()
  })

  it('stops before calling the model when the hosted account is not ready', async () => {
    const ensureHostedAccountReady = vi.fn(async () => false)
    const translate = await mountTranslator({
      model: { providerKind: 'kition_console', runtimeModel: { ...runtimeModel, provider_type: 'kition_console' } },
      ensureHostedAccountReady,
    })
    await expect(translate('Hello', 'fr', new AbortController().signal)).rejects.toBeInstanceOf(TranslationAccountNotReadyError)
    expect(chatWithModel).not.toHaveBeenCalled()
  })

  it('sends one completion with the selected model and returns the cleaned translation', async () => {
    vi.mocked(chatWithModel).mockResolvedValue({ content: '```\nBonjour\n```' })
    const controller = new AbortController()
    const translate = await mountTranslator({ model: { providerKind: 'openai', runtimeModel } })

    await expect(translate('Hello', 'fr', controller.signal)).resolves.toBe('Bonjour')
    const [body, options] = vi.mocked(chatWithModel).mock.calls[0]
    expect(body.runtime_model).toBe(runtimeModel)
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' })
    expect(body.messages[0].content).toContain('French')
    expect(options).toEqual({ signal: controller.signal })
  })
})
