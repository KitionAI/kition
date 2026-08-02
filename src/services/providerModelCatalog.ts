import { discoverProviderModels } from '@/api/desktop'
import { saveDesktopSettings } from '@/services/desktopSettings'
import { isLikelyTextGenerationModel } from '@/services/modelCapabilities'
import type { DesktopProviderKind, DesktopSettingsState } from '@/types/desktopSettings'

function normalizeDiscoveredModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((model) => String(model || '').trim()).filter(Boolean)))
}

function resolveDiscoveredProviderBaseURL(
  currentBaseURL: string,
  modelsPath: string,
  endpoint: unknown,
) {
  if (currentBaseURL.trim()) return currentBaseURL
  const discoveredEndpoint = String(endpoint || '').trim()
  if (!discoveredEndpoint) return ''

  try {
    const url = new URL(discoveredEndpoint)
    const normalizedModelsPath = `/${String(modelsPath || '/models').replace(/^\/+|\/+$/g, '')}`
    if (url.pathname.endsWith(normalizedModelsPath)) {
      url.pathname = url.pathname.slice(0, -normalizedModelsPath.length) || '/'
    }
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export async function syncProviderModelCatalog(
  settings: DesktopSettingsState,
  kind: DesktopProviderKind,
  emptyMessage: string,
  activateProvider: boolean,
) {
  const provider = settings.providers[kind]
  const response = await discoverProviderModels({
    provider_type: kind,
    base_url: provider.baseUrl || undefined,
    api_key: provider.apiKey || undefined,
    access_token: provider.accessToken || undefined,
    models_path: provider.modelsPath || undefined,
    auth_header: provider.authHeader || undefined,
    auth_scheme: provider.authScheme,
  })
  const models = normalizeDiscoveredModels(response?.models)
  if (!models.length) throw new Error(emptyMessage)
  const discoveredBaseURL = kind === 'kition_console'
    ? resolveDiscoveredProviderBaseURL(provider.baseUrl, provider.modelsPath, response?.endpoint)
    : provider.baseUrl

  const selectedModelByProvider = { ...settings.models.selectedModelByProvider }
  const currentSelection = selectedModelByProvider[kind] || ''
  const fallbackSelection = kind === 'kition_console'
    ? models.find(isLikelyTextGenerationModel) || ''
    : models[0]
  const currentSelectionIsUsable = Boolean(
    currentSelection
    && models.includes(currentSelection)
    && (kind !== 'kition_console' || isLikelyTextGenerationModel(currentSelection)),
  )
  if (!currentSelectionIsUsable) {
    if (fallbackSelection) selectedModelByProvider[kind] = fallbackSelection
    else delete selectedModelByProvider[kind]
  }
  const selectedModel = selectedModelByProvider[kind] || fallbackSelection
  const nextModels = {
    ...settings.models,
    activeProvider: activateProvider ? kind : settings.models.activeProvider,
    selectedModelByProvider,
  }
  if (activateProvider && selectedModel) {
    nextModels.preferredDefaultModel = !settings.models.preferredDefaultModel || !models.includes(settings.models.preferredDefaultModel)
      ? selectedModel
      : settings.models.preferredDefaultModel
    nextModels.preferredChatModel = !settings.models.preferredChatModel || !models.includes(settings.models.preferredChatModel)
      ? selectedModel
      : settings.models.preferredChatModel
    nextModels.preferredWritingModel = !settings.models.preferredWritingModel || !models.includes(settings.models.preferredWritingModel)
      ? selectedModel
      : settings.models.preferredWritingModel
  }

  return saveDesktopSettings({
    ...settings,
    providers: {
      ...settings.providers,
      [kind]: {
        ...provider,
        baseUrl: discoveredBaseURL,
        enabled: true,
        discoveredModels: models,
        lastSyncedAt: response.fetched_at || new Date().toISOString(),
      },
    },
    models: nextModels,
  })
}
