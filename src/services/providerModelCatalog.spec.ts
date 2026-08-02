import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  discoverProviderModels: vi.fn(),
}))
const settingsMocks = vi.hoisted(() => ({
  saveDesktopSettings: vi.fn(),
}))

vi.mock('@/api/desktop', () => ({
  discoverProviderModels: apiMocks.discoverProviderModels,
}))

vi.mock('@/services/desktopSettings', async () => {
  const actual = await vi.importActual<typeof import('@/services/desktopSettings')>('@/services/desktopSettings')
  return {
    ...actual,
    saveDesktopSettings: settingsMocks.saveDesktopSettings,
  }
})

import { createDefaultDesktopSettings } from '@/services/desktopSettings'
import { syncProviderModelCatalog } from '@/services/providerModelCatalog'

describe('syncProviderModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.discoverProviderModels.mockResolvedValue({
      provider_type: 'kition_console',
      endpoint: 'https://kition.ai/api/llm/v1/models',
      models: ['gpt-image-2', 'gpt-5.5'],
      fetched_at: '2026-08-01T10:00:00Z',
    })
    settingsMocks.saveDesktopSettings.mockImplementation(async (settings) => settings)
  })

  it('selects and persists a usable Kition Cloud text model after sign-in', async () => {
    const settings = createDefaultDesktopSettings()
    settings.models.selectedModelByProvider.kition_console = 'gpt-image-2'

    const result = await syncProviderModelCatalog(
      settings,
      'kition_console',
      'No models returned.',
      true,
    )

    expect(apiMocks.discoverProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      provider_type: 'kition_console',
    }))
    expect(result.providers.kition_console.discoveredModels).toEqual(['gpt-image-2', 'gpt-5.5'])
    expect(result.providers.kition_console.baseUrl).toBe('https://kition.ai/api/llm/v1')
    expect(result.models).toMatchObject({
      activeProvider: 'kition_console',
      selectedModelByProvider: { kition_console: 'gpt-5.5' },
      preferredDefaultModel: 'gpt-5.5',
      preferredChatModel: 'gpt-5.5',
      preferredWritingModel: 'gpt-5.5',
    })
  })
})
