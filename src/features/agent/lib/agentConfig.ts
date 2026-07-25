import type { RuntimeWritingModel } from '@/types'
import { KITION_CONSOLE_DEFAULT_TEXT_MODELS } from '@/services/desktopSettings'
import type { DesktopProviderKind, DesktopSettingsState } from '@/types/desktopSettings'

export type AgentModelOption = {
  key: string
  providerKind: DesktopProviderKind
  providerLabel: string
  modelName: string
  runtimeModel: RuntimeWritingModel
}

export function buildWritingRuntimeModel(settings: DesktopSettingsState, modelName: string) {
  if (!modelName) {
    return undefined
  }

  const providerKind = settings.models.activeProvider
  const provider = settings.providers[providerKind]
  if (!provider) {
    return undefined
  }

  return {
    provider_type: providerKind,
    provider_label: provider.label,
    model_name: modelName,
    base_url: provider.baseUrl || '',
    api_key: provider.apiKey || '',
    access_token: provider.accessToken || undefined,
    auth_header: provider.authHeader || undefined,
    auth_scheme: provider.authScheme,
    wire_api: provider.wireApi,
    reasoning_effort: provider.reasoningEffort,
    hosted_web_search_version: provider.hostedWebSearchVersion,
    disable_response_storage: provider.disableResponseStorage,
  }
}

export function resolveAgentTextModel(settings: DesktopSettingsState) {
  const providerKind = settings.models.activeProvider
  return settings.models.selectedModelByProvider[providerKind]
    || settings.models.preferredChatModel
    || settings.models.preferredWritingModel
    || settings.providers[providerKind]?.discoveredModels?.[0]
    || ''
}

export function buildAgentModelOptions(settings: DesktopSettingsState): AgentModelOption[] {
  const options: AgentModelOption[] = []

  for (const providerKind of Object.keys(settings.providers) as DesktopProviderKind[]) {
    const provider = settings.providers[providerKind]
    if (!provider?.enabled) {
      continue
    }

    for (const modelName of provider.discoveredModels || []) {
      if (providerKind === 'kition_console' && !KITION_CONSOLE_DEFAULT_TEXT_MODELS.includes(modelName)) {
        continue
      }

      const runtimeModel = buildWritingRuntimeModel(
        {
          ...settings,
          models: {
            ...settings.models,
            activeProvider: providerKind,
          },
        },
        modelName,
      )

      if (!runtimeModel) {
        continue
      }

      options.push({
        key: `${providerKind}:${modelName}`,
        providerKind,
        providerLabel: provider.label || providerKind,
        modelName,
        runtimeModel,
      })
    }
  }

  return options
}

export function resolveAgentModelKey(
  settings: DesktopSettingsState,
  options: AgentModelOption[],
  currentKey?: string,
) {
  if (currentKey && options.some((option) => option.key === currentKey)) {
    return currentKey
  }

  const providerKind = settings.models.activeProvider
  const preferredModel = resolveAgentTextModel(settings)
  const preferred = options.find(
    (option) => option.providerKind === providerKind && option.modelName === preferredModel,
  )

  if (preferred) {
    return preferred.key
  }

  return options[0]?.key || ''
}

export function isAgentProviderConfigurationError(message: string) {
  return [
    'configure a text model',
    'configure model',
    'Provider',
    'API Key',
    'Access Token',
    'base_url',
    'model_name',
    'invalid URL',
    'credentials',
    'invalid token',
    'configuration',
    '401',
    '403',
  ].some((token) => message.includes(token))
}
