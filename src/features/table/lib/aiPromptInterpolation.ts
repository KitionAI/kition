import type { AnyAIConfig } from '@/types/aiConfig'
import type { DataField, DataRecord } from '@/types/dataDocument'

const PROMPT_PLACEHOLDER_PATTERN = /{{\s*([^{}]+?)\s*}}/g

function describeAttachmentValue(value: unknown) {
  const count = Array.isArray(value) ? value.length : value ? 1 : 0
  if (count === 0) return 'no reference image provided'
  return count === 1 ? 'the attached reference image' : 'the attached reference images'
}

function describeObjectValue(value: Record<string, unknown>) {
  return String(
    value.display
    || value.name
    || value.title
    || value.label
    || value.row_key
    || '',
  ).trim()
}

function describePromptValue(field: DataField, value: unknown) {
  if (field.type === 'attachment') return describeAttachmentValue(value)
  if (value === null || value === undefined || value === '') return 'not provided'
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => {
        if (item && typeof item === 'object') {
          return describeObjectValue(item as Record<string, unknown>)
        }
        return String(item ?? '').trim()
      })
      .filter(Boolean)
      .join(', ')
    return rendered || 'not provided'
  }
  if (typeof value === 'object') {
    return describeObjectValue(value as Record<string, unknown>) || 'not provided'
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value).trim() || 'not provided'
}

export function hasAIFieldPromptPlaceholders(config: AnyAIConfig) {
  return 'prompt' in config && /{{\s*[^{}]+?\s*}}/.test(config.prompt)
}

export function materializeAIFieldPrompt(
  config: AnyAIConfig,
  record: DataRecord,
  fields: DataField[],
): AnyAIConfig {
  if (!('prompt' in config) || !hasAIFieldPromptPlaceholders(config)) return config
  const fieldByToken = new Map<string, DataField>()
  for (const field of fields) {
    fieldByToken.set(field.name, field)
    fieldByToken.set(field.title, field)
  }
  const prompt = config.prompt.replace(
    PROMPT_PLACEHOLDER_PATTERN,
    (_placeholder, token: string) => {
      const field = fieldByToken.get(token.trim())
      if (!field) return 'not provided'
      return describePromptValue(field, record.values?.[field.name])
    },
  )
  return { ...config, prompt }
}
