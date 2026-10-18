/**
 * The zod schemas for per-field AI configuration. Kept apart from the
 * zod-free helpers in `aiConfig.ts` so the startup bundle, which only
 * normalizes stored configs, does not carry the validator.
 */
import { z } from 'zod'

export const MAX_AI_IMAGE_VARIANTS = 5

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
  n: z.number().int().min(1).max(MAX_AI_IMAGE_VARIANTS).default(1),
  quality: qualitySchema.default('medium'),
  aspect_ratio: aspectRatioSchema.default('1:1'),
  resolution: resolutionSchema.default('1K'),
  image_use_case: useCaseSchema.default('inline_illustration'),
})

const imageCustomizationConfig = aiConfigBase.extend({
  type: z.literal('image_customization'),
  prompt: z.string().min(1),
  source_field_id: z.number().int().positive().optional(),
  n: z.number().int().min(1).max(MAX_AI_IMAGE_VARIANTS).default(1),
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
