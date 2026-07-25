import { z } from 'zod'
import type { DataFieldType } from './dataDocument'

const aiConfigBase = z.object({
  enabled: z.boolean(),
  auto_update: z.boolean(),
  runtime_model: z.string().optional(),
})

const aspectRatioSchema = z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2'])
const resolutionSchema = z.enum(['1K', '2K', '4K'])
const qualitySchema = z.enum(['low', 'medium', 'high'])

export const useCaseSchema = z.enum([
  'cover_illustration',
  'inline_illustration',
  'infographic_diagram',
  'product_showcase',
  'icon_brand',
  'other',
])
export type DataFieldAIImageUseCase = z.infer<typeof useCaseSchema>

const imageGenerationConfig = aiConfigBase.extend({
  type: z.literal('image_generation'),
  source_field_id: z.number().int().positive(),
  n: z.number().int().min(1).max(10).default(1),
  size: z.string().regex(/^\d+x\d+$/).optional(),
  quality: qualitySchema.default('medium'),
  aspect_ratio: aspectRatioSchema.default('1:1'),
  resolution: resolutionSchema.default('1K'),
  image_use_case: useCaseSchema.default('inline_illustration'),
})

const imageCustomizationConfig = aiConfigBase.extend({
  type: z.literal('image_customization'),
  prompt: z.string().min(1),
  source_field_id: z.number().int().positive().optional(),
  n: z.number().int().min(1).max(10).default(1),
  quality: qualitySchema.default('medium'),
  aspect_ratio: aspectRatioSchema.default('1:1'),
  resolution: resolutionSchema.default('1K'),
  image_use_case: useCaseSchema.default('inline_illustration'),
})

export const attachmentAIConfigSchema = z.discriminatedUnion('type', [
  imageGenerationConfig,
  imageCustomizationConfig,
])
export type AttachmentAIConfig = z.infer<typeof attachmentAIConfigSchema>

const textGenerationConfig = aiConfigBase.extend({
  type: z.literal('text_generation'),
  prompt: z.string().min(1),
})

const summarizeConfig = aiConfigBase.extend({
  type: z.literal('summarize'),
  source_field_id: z.number().int().positive(),
  max_words: z.number().int().positive().optional(),
})

const extractConfig = aiConfigBase.extend({
  type: z.literal('extract'),
  source_field_id: z.number().int().positive(),
  schema: z.string().optional(),
})

const translateConfig = aiConfigBase.extend({
  type: z.literal('translate'),
  source_field_id: z.number().int().positive(),
  target_language: z.string().min(2),
})

const classifyConfig = aiConfigBase.extend({
  type: z.literal('classify'),
  source_field_id: z.number().int().positive(),
  categories: z.array(z.string()).min(2),
})

const customizeConfig = aiConfigBase.extend({
  type: z.literal('customize'),
  prompt: z.string().min(1),
})

export const textAIConfigSchema = z.discriminatedUnion('type', [
  textGenerationConfig,
  summarizeConfig,
  extractConfig,
  translateConfig,
  classifyConfig,
  customizeConfig,
])
export type TextAIConfig = z.infer<typeof textAIConfigSchema>

export type AnyAIConfig = AttachmentAIConfig | TextAIConfig

export function getAIConfigSchemaForField(
  fieldType: DataFieldType,
): typeof attachmentAIConfigSchema | typeof textAIConfigSchema | null {
  switch (fieldType) {
    case 'attachment':
      return attachmentAIConfigSchema
    case 'text':
    case 'long_text':
      return textAIConfigSchema
    default:
      return null
  }
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
