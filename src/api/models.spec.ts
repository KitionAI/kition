import { beforeEach, describe, expect, it, vi } from 'vitest'

import { expectMatchesContract } from '@/test/contracts'
import request from './request'
import { chatWithModel } from './models'

vi.mock('./request', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

describe('chatWithModel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('posts a contract-shaped one-shot request and forwards the abort signal', async () => {
    vi.mocked(request.post).mockResolvedValue({ content: 'Bonjour' } as never)
    const controller = new AbortController()

    await chatWithModel({
      messages: [
        { role: 'system', content: 'Translate to French.' },
        { role: 'user', content: 'Hello' },
      ],
      runtime_model: {
        provider_type: 'openai',
        provider_label: 'OpenAI',
        model_name: 'example-model',
        base_url: 'https://api.example.com/v1',
        api_key: 'test-key',
      },
    }, { signal: controller.signal })

    const [path, body, config] = vi.mocked(request.post).mock.calls[0]
    expect(path).toBe('/v1/ai/chat')
    expectMatchesContract(body, 'ai-chat', 'request')
    expect(config).toMatchObject({ signal: controller.signal, suppressErrorMessage: true })
  })
})
