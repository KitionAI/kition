import type { AttachmentAIConfig, TextAIConfig } from './aiConfigSchemas'

export type { AttachmentAIConfig, DataFieldAIImageUseCase, TextAIConfig } from './aiConfigSchemas'

export type AnyAIConfig = AttachmentAIConfig | TextAIConfig

export function normalizeAIConfig<T extends AnyAIConfig | null | undefined>(config: T): T {
  if (
    !config
    || (config.type !== 'image_generation' && config.type !== 'image_customization')
    || !('size' in config)
  ) return config
  const normalized = { ...config } as T & { size?: unknown }
  delete normalized.size
  return normalized
}

export function isAttachmentAIConfig(config: AnyAIConfig | undefined): config is AttachmentAIConfig {
  return !!config && (config.type === 'image_generation' || config.type === 'image_customization')
}

export function isTextAIConfig(config: AnyAIConfig | undefined): config is TextAIConfig {
  if (!config) return false
  switch (config.type) {
    case 'text_generation':
    case 'summarize':
    case 'extract':
    case 'translate':
    case 'classify':
    case 'customize':
      return true
    default:
      return false
  }
}
