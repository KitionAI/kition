import { beforeEach, describe, expect, it, vi } from 'vitest'

const secureValues = new Map<string, string>()

vi.mock('@/services/desktop', () => ({
  getSecureValue: vi.fn(async (key: string) => secureValues.get(key) || ''),
  setSecureValue: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value)
  }),
  deleteSecureValue: vi.fn(async (key: string) => {
    secureValues.delete(key)
  }),
}))

describe('desktopSettings provider secret persistence', () => {
  beforeEach(() => {
    secureValues.clear()
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-desktop-theme')
    document.documentElement.removeAttribute('data-desktop-theme-mode')
    document.documentElement.style.colorScheme = ''
  })

  it('hydrates provider api keys from dedicated secret storage on load', async () => {
    secureValues.set(
      'kition.desktop.settings.v1',
      JSON.stringify({
        providers: {
          openai: {
            enabled: true,
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            discoveredModels: ['gpt-4.1'],
          },
        },
      }),
    )
    secureValues.set('desktop.provider.openai.apiKey.v1', 'live-secret')

    const { loadDesktopSettings } = await import('./desktopSettings')
    const settings = await loadDesktopSettings()

    expect(settings.providers.openai.apiKey).toBe('live-secret')
  })

  it('migrates legacy inline provider secrets into dedicated secret storage', async () => {
    secureValues.set(
      'kition.desktop.settings.v1',
      JSON.stringify({
        providers: {
          openai: {
            enabled: true,
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'legacy-secret',
          },
        },
      }),
    )

    const { loadDesktopSettings } = await import('./desktopSettings')
    const settings = await loadDesktopSettings()

    expect(settings.providers.openai.apiKey).toBe('legacy-secret')
    expect(secureValues.get('desktop.provider.openai.apiKey.v1')).toBe(
      'legacy-secret',
    )
  })

  it('preserves existing provider secrets when a later save carries a blank key', async () => {
    secureValues.set('desktop.provider.openai.apiKey.v1', 'persisted-secret')

    const { createDefaultDesktopSettings, saveDesktopSettings } = await import(
      './desktopSettings'
    )
    const settings = createDefaultDesktopSettings()
    settings.providers.openai.enabled = true
    settings.providers.openai.apiKey = ''

    const saved = await saveDesktopSettings(settings)
    const persistedBlob = JSON.parse(
      secureValues.get('kition.desktop.settings.v1') || '{}',
    )

    expect(saved.providers.openai.apiKey).toBe('persisted-secret')
    expect(secureValues.get('desktop.provider.openai.apiKey.v1')).toBe(
      'persisted-secret',
    )
    expect(persistedBlob.providers.openai.apiKey).toBe('')
  })

  it('deletes provider secrets when the provider is explicitly disconnected', async () => {
    secureValues.set('desktop.provider.openai.apiKey.v1', 'persisted-secret')

    const { createDefaultDesktopSettings, saveDesktopSettings } = await import(
      './desktopSettings'
    )
    const settings = createDefaultDesktopSettings()
    settings.providers.openai.enabled = false
    settings.providers.openai.apiKey = ''

    await saveDesktopSettings(settings, { clearProviderSecrets: ['openai'] })

    expect(secureValues.get('desktop.provider.openai.apiKey.v1') || '').toBe('')
  })

  it('does not delete a persisted secret for a disabled provider during a regular save', async () => {
    secureValues.set('desktop.provider.openai.apiKey.v1', 'persisted-secret')

    const { createDefaultDesktopSettings, saveDesktopSettings } = await import(
      './desktopSettings'
    )
    const settings = createDefaultDesktopSettings()
    settings.providers.openai.enabled = false
    settings.providers.openai.apiKey = ''

    const saved = await saveDesktopSettings(settings)

    expect(saved.providers.openai.apiKey).toBe('persisted-secret')
    expect(secureValues.get('desktop.provider.openai.apiKey.v1')).toBe(
      'persisted-secret',
    )
  })

  it('falls back to the local backup when the secure settings blob cannot be parsed', async () => {
    secureValues.set('kition.desktop.settings.v1', 'not-json')
    secureValues.set('desktop.provider.openai.apiKey.v1', 'live-secret')
    localStorage.setItem(
      'kition.desktop.settings.backup.v1',
      JSON.stringify({
        providers: {
          openai: {
            enabled: true,
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            discoveredModels: ['gpt-4.1'],
            lastSyncedAt: '2026-05-22T00:00:00.000Z',
          },
        },
      }),
    )

    const { loadDesktopSettings } = await import('./desktopSettings')
    const settings = await loadDesktopSettings()

    expect(settings.providers.openai.apiKey).toBe('live-secret')
    expect(settings.providers.openai.discoveredModels).toEqual(['gpt-4.1'])
    expect(settings.providers.openai.lastSyncedAt).toBe(
      '2026-05-22T00:00:00.000Z',
    )
  })
})

describe('desktopSettings AI provider catalog', () => {
  it('keeps Kition Cloud first and includes DeepSeek and Kimi presets', async () => {
    const {
      createDefaultDesktopSettings,
      desktopProviderCatalog,
      normalizeProviderBaseURL,
    } = await import('./desktopSettings')

    expect(desktopProviderCatalog[0]?.kind).toBe('kition_console')
    expect(desktopProviderCatalog.map((provider) => provider.kind)).toContain('deepseek')
    expect(desktopProviderCatalog.map((provider) => provider.kind)).toContain('kimi')

    const settings = createDefaultDesktopSettings()
    expect(settings.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(settings.providers.kimi.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(normalizeProviderBaseURL('kimi', 'https://api.moonshot.cn')).toBe('https://api.moonshot.cn/v1')
  })
})

describe('desktopSettings display / notifications / hooks normalization', () => {
  beforeEach(() => {
    secureValues.clear()
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-desktop-theme')
    document.documentElement.removeAttribute('data-desktop-theme-mode')
    document.documentElement.style.colorScheme = ''
  })

  it('fills missing display / notifications / hooks branches with defaults', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings({})
    expect(result.general.theme).toBe('dark')
    expect(result.display).toEqual({
      zoomLevel: 1,
      density: 'normal',
      codeFontFamily: 'JetBrains Mono',
      codeFontSize: 13,
      reduceMotion: false,
      agentTimelineLineHeight: 'normal',
      showDocumentToolbar: false,
    })
    expect(result.notifications).toEqual({
      systemNotificationsEnabled: true,
      onTaskCompleted: true,
      onTaskFailed: true,
      onUserInputNeeded: true,
      longRunningThresholdSeconds: 0,
    })
    expect(result.hooks).toEqual([])
  })

  it('defaults fresh installs to dark theme appearance', async () => {
    const { createDefaultDesktopSettings, loadDesktopSettings, applyDesktopAppearance } = await import('./desktopSettings')
    expect(createDefaultDesktopSettings().general.theme).toBe('dark')

    const settings = await loadDesktopSettings()
    expect(settings.general.theme).toBe('dark')

    applyDesktopAppearance(settings.general.theme)
    expect(document.documentElement.dataset.desktopThemeMode).toBe('dark')
    expect(document.documentElement.dataset.desktopTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('keeps a saved dark theme after reloading settings', async () => {
    const { createDefaultDesktopSettings, loadDesktopSettings, saveDesktopSettings } = await import('./desktopSettings')
    const settings = createDefaultDesktopSettings()
    settings.general.theme = 'dark'

    await saveDesktopSettings(settings)
    const reloaded = await loadDesktopSettings()

    expect(reloaded.general.theme).toBe('dark')
    expect(JSON.parse(secureValues.get('kition.desktop.settings.v1') || '{}').general.theme).toBe('dark')
    expect(localStorage.getItem('kition.desktop.theme.bootstrap.v1')).toBe('dark')
  })

  it('preserves an explicit light preference after the dark-default migration has run', async () => {
    localStorage.setItem('kition.desktop.theme.darkDefaultMigration.v1', 'done')
    secureValues.set('kition.desktop.settings.v1', JSON.stringify({ general: { theme: 'light' } }))

    const { loadDesktopSettings } = await import('./desktopSettings')
    const settings = await loadDesktopSettings()

    expect(settings.general.theme).toBe('light')
  })

  it('preserves the discovered Kition Cloud catalog and selects an available text model', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings({
      providers: {
        kition_console: {
          enabled: true,
          discoveredModels: ['gpt-5.5', 'gpt-image-2'],
        },
      } as any,
      models: {
        activeProvider: 'kition_console',
        selectedModelByProvider: {
          kition_console: 'gpt-4.1',
        },
      } as any,
    })

    expect(result.providers.kition_console.enabled).toBe(true)
    expect(result.providers.kition_console.discoveredModels).toEqual(['gpt-5.5', 'gpt-image-2'])
    expect(result.models.selectedModelByProvider.kition_console).toBe('gpt-5.5')
  })

  it('does not invent a Kition Cloud catalog before discovery', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings()

    expect(result.providers.kition_console.discoveredModels).toEqual([])
  })

  it('purges the legacy hard-coded Kition Cloud catalog', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings({
      providers: {
        kition_console: {
          enabled: true,
          discoveredModels: ['gpt-5.5', 'gpt-image-1', 'dall-e-3'],
        },
      } as any,
      models: {
        activeProvider: 'kition_console',
        selectedModelByProvider: {
          kition_console: 'gpt-image-1',
        },
      } as any,
    })

    expect(result.providers.kition_console.discoveredModels).toEqual([])
    expect(result.models.selectedModelByProvider.kition_console).toBeUndefined()
  })

  it('preserves provided display value and falls back others to defaults', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings({
      display: { zoomLevel: 1.3 } as any,
    })
    expect(result.display.zoomLevel).toBe(1.3)
    expect(result.display.density).toBe('normal')
    expect(result.display.codeFontFamily).toBe('JetBrains Mono')
  })

  it('clamps zoomLevel and codeFontSize to their valid ranges', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const tooHigh = normalizeDesktopSettings({ display: { zoomLevel: 5, codeFontSize: 999 } as any })
    expect(tooHigh.display.zoomLevel).toBe(1.5)
    expect(tooHigh.display.codeFontSize).toBe(18)

    const tooLow = normalizeDesktopSettings({ display: { zoomLevel: 0.1, codeFontSize: 3 } as any })
    expect(tooLow.display.zoomLevel).toBe(0.85)
    expect(tooLow.display.codeFontSize).toBe(12)
  })

  it('drops malformed hook entries and clamps timeoutSeconds', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const result = normalizeDesktopSettings({
      hooks: [
        { id: 'h1', name: 'a', enabled: true, event: 'task_completed', command: 'echo', workdir: '/tmp', timeoutSeconds: 9999 },
        { id: '', name: 'no-id' } as any,
        { id: 'h2', name: 'b', enabled: false, event: 'unknown', command: 'x', workdir: '', timeoutSeconds: 0 } as any,
      ],
    })
    expect(result.hooks).toHaveLength(2)
    expect(result.hooks[0].timeoutSeconds).toBe(300)
    expect(result.hooks[1].event).toBe('task_completed') // fallback for unknown
    expect(result.hooks[1].timeoutSeconds).toBe(1)
  })

  it('applyDesktopDisplay writes CSS variables and dataset', async () => {
    const { applyDesktopDisplay, createDefaultDesktopDisplaySettings } = await import('./desktopSettings')
    applyDesktopDisplay({ ...createDefaultDesktopDisplaySettings(), zoomLevel: 1.2, density: 'compact', reduceMotion: true })
    const root = document.documentElement
    expect(root.style.getPropertyValue('--app-zoom')).toBe('1.2')
    expect(root.dataset.density).toBe('compact')
    expect(root.dataset.reduceMotion).toBe('1')

    applyDesktopDisplay({ ...createDefaultDesktopDisplaySettings(), reduceMotion: false })
    expect(root.dataset.reduceMotion).toBeUndefined()
  })

  it('loadDesktopSettings persists the legacy light-to-dark migration and backfills display defaults', async () => {
    secureValues.set(
      'kition.desktop.settings.v1',
      JSON.stringify({ general: { theme: 'light' } }), // legacy JSON: no display branch
    )
    const { loadDesktopSettings } = await import('./desktopSettings')
    const settings = await loadDesktopSettings()
    const persisted = JSON.parse(secureValues.get('kition.desktop.settings.v1') || '{}')
    expect(settings.general.theme).toBe('dark')
    const backup = JSON.parse(localStorage.getItem('kition.desktop.settings.backup.v1') || '{}')
    expect(backup.display).toBeDefined()
    expect(backup.notifications).toBeDefined()
    expect(Array.isArray(backup.hooks)).toBe(true)
    expect(persisted.general.theme).toBe('dark')
  })

  it('applyDesktopAppearance wraps theme changes in a two-frame transition guard', async () => {
    const frames: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    const { applyDesktopAppearance } = await import('./desktopSettings')
    applyDesktopAppearance('dark')

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('theme-transitioning')).toBe(true)
    expect(document.documentElement.dataset.desktopTheme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    frames.shift()?.(0)
    expect(document.documentElement.classList.contains('theme-transitioning')).toBe(true)
    frames.shift()?.(16)
    expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false)

    requestAnimationFrameSpy.mockRestore()
  })

  it('defaults updateBetaChannel to false', async () => {
    const { createDefaultDesktopSettings } = await import('./desktopSettings')
    expect(createDefaultDesktopSettings().general.updateBetaChannel).toBe(false)
  })

  it('keeps anonymous usage analytics off by default and preserves explicit consent', async () => {
    const { createDefaultDesktopSettings, normalizeDesktopSettings } = await import('./desktopSettings')
    expect(createDefaultDesktopSettings().general.shareUsageData).toBe(false)
    expect(normalizeDesktopSettings({ general: { shareUsageData: true } } as any).general.shareUsageData).toBe(true)
  })

  it('preserves updateBetaChannel through normalize when set', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const input = { general: { updateBetaChannel: true } } as any
    expect(normalizeDesktopSettings(input).general.updateBetaChannel).toBe(true)
  })

  it('applyDesktopAppearance normalizes legacy system theme before writing root state', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    const { applyDesktopAppearance } = await import('./desktopSettings')
    applyDesktopAppearance('system')

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.desktopThemeMode).toBe('auto')
    expect(document.documentElement.dataset.desktopTheme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    matchMediaSpy.mockRestore()
  })
})
