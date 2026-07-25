import { getAIModels } from '@/api/models'
import { loadDesktopSettings } from '@/services/desktopSettings'
import { unwrapArrayResponse } from '@/utils/api'
import type { AIModel, ModelCapability, RuntimeWritingModel } from '@/types'
import type { DesktopProviderConfig, DesktopProviderKind } from '@/types/desktopSettings'

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
  custom: ['text', 'image', 'vision', 'video', 'audio'],
  // Hosted KitionAI Console proxy: text + image + vision. Video is intentionally
  // excluded — the console does not yet proxy video generation, so exposing it
  // here would just produce `video_not_supported_in_cloud` errors at runtime.
  kition_console: ['text', 'image', 'vision'],
}

const CAPABILITY_NAME_FRAGMENTS: Record<Exclude<ModelCapability, 'text'>, readonly string[]> = {
  image: [
    'image', 'dall-e', 'dalle', 'imagen', 'imagery',
    'flux', 'sdxl', 'sd3', 'stable-diffusion',
    'midjourney', 'ideogram',
  ],
  // Vision (multimodal image input) is harder to gate by name than image
  // generation: many flagship models support vision without saying so in
  // the model name (gpt-4-turbo, claude-3, gemini-1.5). The list below errs
  // on the side of inclusion — we'd rather show a non-vision model than
  // hide a vision one. The hint banner in AIConfigPanel catches the rest.
  vision: [
    'gpt-4', 'gpt-5', 'gpt-o', 'o1', 'o3', 'o4', 'omni',
    'claude-3', 'claude-4', 'claude-5', 'sonnet', 'haiku', 'opus',
    'gemini', 'pixtral', 'llava', 'internvl', 'qwen-vl', 'qwen2-vl', 'qwen3-vl',
    'deepseek-vl', 'yi-vl', 'glm-4v', 'minicpm-v', 'molmo',
    'vision', 'multimodal', 'vl-', 'mllm',
    'llama-3.2', 'llama-4', 'mistral-large', 'pixtral',
  ],
  video: ['video', 'sora', 'veo', 'kling', 'runway'],
  audio: ['whisper', 'tts', 'audio', 'voice', 'eleven'],
}

export function supportsDiscoveredDesktopModelCapability(
  modelName: string,
  capability: ModelCapability,
): boolean {
  const normalized = modelName.trim().toLowerCase()
  if (!normalized) return false
  if (capability === 'text') return true
  return CAPABILITY_NAME_FRAGMENTS[capability].some((fragment) =>
    normalized.includes(fragment),
  )
}

const buildDesktopRuntimeModel = (
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
    const token = provider.apiKey || provider.accessToken
    // KitionAI Console resolves its baseUrl and access token server-side from
    // the active portal session, so we do not gate it on locally-stored
    // credentials. Every other provider must have user-supplied credentials.
    const isHostedConsole = kind === 'kition_console'
    if (!provider.enabled) {
      continue
    }
    if (!isHostedConsole && (!provider.baseUrl || !token)) {
      continue
    }
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
