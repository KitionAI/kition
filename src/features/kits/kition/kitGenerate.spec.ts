import { describe, expect, it, vi } from 'vitest'

const generateForKit = vi.fn()
const settings = {
  models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-test' } },
  providers: { openai: { enabled: true, baseUrl: 'https://api.example.test', apiKey: 'fake-key', discoveredModels: ['gpt-test'] } },
}

vi.mock('@/api/aiGenerate', () => ({ AiGenerateError: class extends Error {}, generateForKit: (...args: unknown[]) => generateForKit(...args) }))
vi.mock('@/services/desktopSettings', () => ({ loadDesktopSettings: async () => settings }))
vi.mock('@/services/portalAccount', () => ({ ensurePortalAccountSessionRestored: async () => undefined }))
vi.mock('@/services/mediaModels', () => ({
  canUseDesktopProvider: () => true,
  buildDesktopRuntimeModel: (kind: string, _provider: unknown, model: string) => ({ provider_type: kind, model_name: model }),
  resolvePreferredDesktopMediaModel: () => ({ provider_type: 'openai', model_name: 'image-test' }),
}))

describe('kitionGenerate', () => {
  it('runs an AI field prompt on the person\'s model and hands image bytes over as base64', async () => {
    const { kitionGenerate } = await import('./kitGenerate')
    generateForKit.mockResolvedValue({ text: 'A summary', model: 'gpt-test', usage: { inputTokens: 4, outputTokens: 2 } })
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const answer = await kitionGenerate({
      purpose: 'ai-field',
      output: 'text',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Summarize' }, { type: 'image', mime: 'image/png', bytes }, { type: 'image', url: 'https://example.com/a.png' }] }],
    })
    expect(answer).toEqual({ text: 'A summary', model: 'gpt-test', usage: { inputTokens: 4, outputTokens: 2 } })
    expect(generateForKit).toHaveBeenCalledWith({
      purpose: 'ai-field',
      output: 'text',
      runtimeModel: { provider_type: 'openai', model_name: 'gpt-test' },
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Summarize' }, { type: 'image', mime: 'image/png', data: 'AQID' }, { type: 'image', url: 'https://example.com/a.png' }] }],
    })
  })

  it('answers an image as bytes, on the preferred image model', async () => {
    const { kitionGenerate } = await import('./kitGenerate')
    generateForKit.mockClear()
    generateForKit.mockResolvedValue({ image: { mime: 'image/png', data: 'AQID' }, model: 'image-test' })
    const answer = await kitionGenerate({ purpose: 'ai-field', output: 'image', messages: [{ role: 'user', parts: [{ type: 'text', text: 'A cat' }] }] })
    expect(new Uint8Array(answer.image!.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(generateForKit.mock.calls[0][0].runtimeModel).toEqual({ provider_type: 'openai', model_name: 'image-test' })
  })

  it('serves a rewrite of the person\'s selection under its own purpose', async () => {
    const { kitionGenerate } = await import('./kitGenerate')
    generateForKit.mockClear()
    generateForKit.mockResolvedValue({ text: 'A short line.', model: 'gpt-test' })
    const answer = await kitionGenerate({ purpose: 'rewrite', output: 'text', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Shorten: a rather long line.' }] }] })
    expect(answer).toEqual({ text: 'A short line.', model: 'gpt-test' })
    expect(generateForKit.mock.calls[0][0]).toMatchObject({ purpose: 'rewrite', output: 'text' })
  })

  it('refuses a kit\'s own purpose and unknown purposes, and passes the runtime\'s reason on', async () => {
    const { kitionGenerate } = await import('./kitGenerate')
    generateForKit.mockClear()
    for (const purpose of ['note.outline', 'chat', '']) {
      await expect(kitionGenerate({ purpose: purpose as 'rewrite', output: 'text', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] })).rejects.toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
    }
    expect(generateForKit).not.toHaveBeenCalled()
    generateForKit.mockImplementation(() => Promise.reject(Object.assign(new Error('No credits left'), { reason: 'quota' })))
    const refused = await kitionGenerate({ purpose: 'ai-field', output: 'text', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: -32000, data: { reason: 'quota' }, message: 'No credits left' })
  })
})
