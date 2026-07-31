import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadDesktopSettings } from '@/services/desktopSettings'
import type { AttachmentAIConfig } from '@/types/aiConfig'

vi.mock('@/services/desktopSettings', () => ({
  loadDesktopSettings: vi.fn(),
}))

import { resolveAIConfigRuntimeModel } from './tableEditorShared'

const imageConfig: AttachmentAIConfig = {
  type: 'image_customization',
  enabled: true,
  auto_update: true,
  prompt: 'Create an image for {{title}}',
  n: 1,
  quality: 'medium',
  aspect_ratio: '9:16',
  resolution: '2K',
  image_use_case: 'cover_illustration',
}

describe('resolveAIConfigRuntimeModel for image fields', () => {
  beforeEach(() => {
    vi.mocked(loadDesktopSettings).mockResolvedValue({
      models: {
        activeProvider: 'kition_console',
        selectedModelByProvider: { kition_console: 'gpt-5.5' },
      },
      providers: {
        kition_console: {
          enabled: true,
          label: 'Kition Cloud',
          baseUrl: '',
          apiKey: '',
          discoveredModels: ['gpt-5.5', 'gpt-image-2'],
        },
      },
    } as any)
  })

  it('automatically selects an image-capable model when no override is stored', async () => {
    await expect(resolveAIConfigRuntimeModel(imageConfig)).resolves.toMatchObject({
      provider_type: 'kition_console',
      provider_label: 'Kition Cloud',
      model_name: 'gpt-image-2',
    })
  })

  it('keeps an explicit image-model override', async () => {
    await expect(resolveAIConfigRuntimeModel({
      ...imageConfig,
      runtime_model: 'desktop:kition_console:gpt-image-2',
    })).resolves.toMatchObject({
      provider_type: 'kition_console',
      model_name: 'gpt-image-2',
    })
  })

  it('returns undefined when no configured image model exists', async () => {
    vi.mocked(loadDesktopSettings).mockResolvedValue({
      models: {
        activeProvider: 'openai',
        selectedModelByProvider: { openai: 'gpt-5.5' },
      },
      providers: {
        openai: {
          enabled: true,
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'test-key',
          discoveredModels: ['gpt-5.5'],
        },
      },
    } as any)

    await expect(resolveAIConfigRuntimeModel(imageConfig)).resolves.toBeUndefined()
  })
})
