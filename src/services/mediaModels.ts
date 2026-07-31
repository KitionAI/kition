import { getAIModels } from '@/api/models'
import { loadDesktopSettings } from '@/services/desktopSettings'
import { unwrapArrayResponse } from '@/utils/api'
import type { AIModel, ModelCapability, RuntimeWritingModel } from '@/types'
import type {
  DesktopProviderConfig,
  DesktopProviderKind,
  DesktopSettingsState,
} from '@/types/desktopSettings'
import { supportsDiscoveredDesktopModelCapability } from '@/services/modelCapabilities'

export { supportsDiscoveredDesktopModelCapability } from '@/services/modelCapabilities'

export type MediaModelOption = {
  value: string
  label: string
  modelName: string
  provider: string
  source: 'backend' | 'desktop'
  aiModelId?: number
  isDefault?: boolean
  providerKind?: DesktopProviderKind
  runtimeModel?: RuntimeWritingModel
}

const desktopCapabilityMap: Record<DesktopProviderKind, ModelCapability[]> = {
  anthropic: ['text', 'image', 'vision'],
  openai: ['text', 'image', 'vision', 'video', 'audio'],
  // DeepSeek serves text-only chat/reasoning models (deepseek-chat,
  // deepseek-reasoner); it does not offer image, vision, audio, or video.
  deepseek: ['text'],
  // Kimi is configured here for text agents. Media generation remains hidden
  // until the runtime contract exposes provider-specific media capabilities.
  kimi: ['text'],
  custom: ['text', 'image', 'vision', 'video', 'audio'],
  // Hosted Kition Cloud proxy: text + image + vision. Video is intentionally
  // excluded — the console does not yet proxy video generation, so exposing it
  // here would just produce `video_not_supported_in_cloud` errors at runtime.
  kition_console: ['text', 'image', 'vision'],
}

export const buildDesktopRuntimeModel = (
  kind: DesktopProviderKind,
  provider: DesktopProviderConfig,
  modelName: string,
): RuntimeWritingModel => ({
  provider_type: kind,
  provider_label: provider.label,
  model_name: modelName,
  base_url: provider.baseUrl,
  api_key: provider.apiKey,
  access_token: provider.accessToken || undefined,
  auth_header: provider.authHeader || undefined,
  auth_scheme: provider.authScheme,
  wire_api: provider.wireApi,
  reasoning_effort: provider.reasoningEffort,
  hosted_web_search_version: provider.hostedWebSearchVersion,
  disable_response_storage: provider.disableResponseStorage,
})

export function canUseDesktopProvider(
  kind: DesktopProviderKind,
  provider: DesktopProviderConfig,
): boolean {
  if (!provider.enabled) return false
  if (kind === 'kition_console') return true
  return Boolean(provider.baseUrl && (provider.apiKey || provider.accessToken))
}

export function resolvePreferredDesktopMediaModel(
  settings: DesktopSettingsState,
  capability: ModelCapability,
): RuntimeWritingModel | undefined {
  const activeProvider = settings.models.activeProvider
  const providerOrder = [
    activeProvider,
    ...Object.keys(settings.providers).filter((kind) => kind !== activeProvider),
  ] as DesktopProviderKind[]

  for (const kind of providerOrder) {
    const provider = settings.providers[kind]
    if (!provider || !desktopCapabilityMap[kind].includes(capability)) continue
    if (!canUseDesktopProvider(kind, provider)) continue

    const selectedModel = settings.models.selectedModelByProvider[kind]
    const candidates = [selectedModel, ...(provider.discoveredModels || [])]
      .filter((candidate): candidate is string => Boolean(candidate))
    const modelName = candidates.find((candidate, index) => (
      candidates.indexOf(candidate) === index
      && supportsDiscoveredDesktopModelCapability(candidate, capability)
    ))
    if (modelName) return buildDesktopRuntimeModel(kind, provider, modelName)
  }

  return undefined
}

export async function loadMediaModelOptions(capability: ModelCapability): Promise<MediaModelOption[]> {
  const [backendRes, desktopSettings] = await Promise.all([getAIModels(capability), loadDesktopSettings()])

  const backendModels = unwrapArrayResponse<AIModel>(backendRes)
  const backendOptions = backendModels.map((model) => ({
    value: `backend:${model.id}`,
    label: `${model.name} (${model.provider})`,
    modelName: model.model_name,
    provider: model.provider,
    source: 'backend' as const,
    aiModelId: model.id,
    isDefault: model.is_default,
  }))

  const desktopOptions: MediaModelOption[] = []
  for (const [kind, provider] of Object.entries(desktopSettings.providers) as Array<[DesktopProviderKind, DesktopProviderConfig]>) {
    // Kition Cloud resolves its baseUrl and access token server-side from
    // the active portal session, so we do not gate it on locally-stored
    // credentials. Every other provider must have user-supplied credentials.
    if (!canUseDesktopProvider(kind, provider)) continue
    if (!provider.discoveredModels?.length) {
      continue
    }
    if (!desktopCapabilityMap[kind].includes(capability)) {
      continue
    }

    for (const modelName of provider.discoveredModels) {
      if (!supportsDiscoveredDesktopModelCapability(modelName, capability)) {
        continue
      }
      desktopOptions.push({
        value: `desktop:${kind}:${modelName}`,
        label: `${modelName} (${provider.label || kind}) [Desktop]`,
        modelName,
        provider: provider.label || kind,
        source: 'desktop',
        providerKind: kind,
        runtimeModel: buildDesktopRuntimeModel(kind, provider, modelName),
      })
    }
  }

  return [...desktopOptions, ...backendOptions]
}
