import type { RuntimeWritingModel } from '@/types'
import { isAttachmentAIConfig, type AnyAIConfig } from '@kition/table-editor'
import type { DesktopProviderKind } from '@/types/desktopSettings'
import { loadDesktopSettings } from '@/services/desktopSettings'
import {
  buildDesktopRuntimeModel,
  canUseDesktopProvider,
  resolvePreferredDesktopMediaModel,
} from '@/services/mediaModels'
import { ensurePortalAccountSessionRestored } from '@/services/portalAccount'

/** The desktop model an AI field's config runs on: its `runtime_model` override, or the app's active provider. */
export async function resolveAIConfigRuntimeModel(
  config: AnyAIConfig,
): Promise<RuntimeWritingModel | undefined> {
  const modelKey = config.runtime_model
  const match = modelKey?.match(/^desktop:([^:]+):(.+)$/)
  if (modelKey && !match) return undefined
  let settings = await loadDesktopSettings()
  const requestedProviderKind = match?.[1] || settings.models.activeProvider
  if (requestedProviderKind === 'kition_console') {
    await ensurePortalAccountSessionRestored()
    settings = await loadDesktopSettings()
  }
  if (match) {
    const providerKind = match[1] as DesktopProviderKind
    const provider = settings.providers[providerKind]
    if (providerKind === 'kition_console' && !provider?.accessToken) {
      throw new Error('Sign in to Kition before using Kition Cloud models.')
    }
    if (providerKind === 'kition_console' && !provider?.baseUrl) {
      throw new Error('Kition Cloud connection is incomplete. Refresh models in Settings and try again.')
    }
    if (!provider || !canUseDesktopProvider(providerKind, provider)) return undefined
    return buildDesktopRuntimeModel(providerKind, provider, match[2])
  }
  if (isAttachmentAIConfig(config)) {
    const runtimeModel = resolvePreferredDesktopMediaModel(settings, 'image')
    if (!runtimeModel && settings.models.activeProvider === 'kition_console') {
      throw new Error('No Kition Cloud image model is available. Refresh models in Settings and try again.')
    }
    return runtimeModel
  }
  const providerKind = settings.models.activeProvider
  const provider = settings.providers[providerKind]
  const modelName = settings.models.selectedModelByProvider[providerKind]
    || settings.models.preferredWritingModel
    || settings.models.preferredChatModel
    || settings.models.preferredDefaultModel
    || provider?.discoveredModels?.[0]
    || ''
  if (!provider) return undefined
  const token = provider?.apiKey || provider?.accessToken
  const isHostedConsole = providerKind === 'kition_console'
  if (isHostedConsole && !provider?.accessToken) {
    throw new Error('Sign in to Kition before using Kition Cloud models.')
  }
  if (isHostedConsole && !provider?.baseUrl) {
    throw new Error('Kition Cloud connection is incomplete. Refresh models in Settings and try again.')
  }
  if (isHostedConsole && !modelName) {
    throw new Error('No Kition Cloud text model is available. Refresh models in Settings and try again.')
  }
  if (
    !provider?.enabled
    || !modelName
    || (!isHostedConsole && (!provider.baseUrl || !token))
  ) {
    return undefined
  }
  return buildDesktopRuntimeModel(providerKind, provider, modelName)
}
