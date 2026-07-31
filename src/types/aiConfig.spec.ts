import { describe, expect, it } from 'vitest'
import {
  attachmentAIConfigSchema,
  textAIConfigSchema,
  getAIConfigSchemaForField,
  isAttachmentAIConfig,
  isTextAIConfig,
  normalizeAIConfig,
  type AnyAIConfig,
} from './aiConfig'

describe('attachmentAIConfigSchema', () => {
  it('accepts a valid image_generation config', () => {
    const result = attachmentAIConfigSchema.safeParse({
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 12,
      n: 2,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
    })
    expect(result.success).toBe(true)
  })

  it('rejects image_generation missing source_field_id', () => {
    const result = attachmentAIConfigSchema.safeParse({
      type: 'image_generation',
      enabled: true,
      auto_update: false,
    })
    expect(result.success).toBe(false)
  })

  it('rejects image_generation with negative source_field_id', () => {
    const result = attachmentAIConfigSchema.safeParse({
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: -1,
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid image_customization config', () => {
    const result = attachmentAIConfigSchema.safeParse({
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Make it look like a watercolor',
    })
    expect(result.success).toBe(true)
  })

  it('limits image variants to five', () => {
    const valid = attachmentAIConfigSchema.safeParse({
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Create five variants',
      n: 5,
    })
    const invalid = attachmentAIConfigSchema.safeParse({
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Create six variants',
      n: 6,
    })
    expect(valid.success).toBe(true)
    expect(invalid.success).toBe(false)
  })

  it('rejects image_customization with empty prompt', () => {
    const result = attachmentAIConfigSchema.safeParse({
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('normalizeAIConfig', () => {
  it('strips a legacy size from image customization configs', () => {
    const config = {
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'Create a thumbnail',
      size: '1792x1024',
    } as unknown as AnyAIConfig
    expect(normalizeAIConfig(config)).not.toHaveProperty('size')
  })

  it('strips a legacy size from image generation configs so aspect ratio wins', () => {
    const config = {
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 1,
      size: '1024x1024',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    } as const

    expect(normalizeAIConfig(config)).not.toBe(config)
    expect(normalizeAIConfig(config)).not.toHaveProperty('size')
    expect(normalizeAIConfig(config)).toMatchObject({ aspect_ratio: '1:1', resolution: '1K' })
  })

  it('accepts null and undefined configs', () => {
    expect(normalizeAIConfig(null)).toBeNull()
    expect(normalizeAIConfig(undefined)).toBeUndefined()
  })
})

describe('useCaseSchema / image_use_case', () => {
  const baseGeneration = {
    type: 'image_generation' as const,
    enabled: true,
    auto_update: false,
    source_field_id: 1,
  }

  const baseCustomization = {
    type: 'image_customization' as const,
    enabled: true,
    auto_update: false,
    prompt: 'Make it pop',
  }

  it('defaults image_use_case to inline_illustration when omitted (image_generation)', () => {
    const result = attachmentAIConfigSchema.safeParse(baseGeneration)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_use_case).toBe('inline_illustration')
    }
  })

  it('defaults image_use_case to inline_illustration when omitted (image_customization)', () => {
    const result = attachmentAIConfigSchema.safeParse(baseCustomization)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_use_case).toBe('inline_illustration')
    }
  })

  it.each([
    'cover_illustration',
    'inline_illustration',
    'infographic_diagram',
    'product_showcase',
    'icon_brand',
    'other',
  ] as const)('accepts image_use_case value "%s"', (useCase) => {
    // useCaseSchema is shared by both image_generation and image_customization;
    // testing against image_generation is sufficient.
    const result = attachmentAIConfigSchema.safeParse({ ...baseGeneration, image_use_case: useCase })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_use_case).toBe(useCase)
    }
  })

  it('rejects an invalid image_use_case value', () => {
    const result = attachmentAIConfigSchema.safeParse({ ...baseGeneration, image_use_case: 'banner' })
    expect(result.success).toBe(false)
  })
})

describe('textAIConfigSchema', () => {
  it('accepts text_generation with prompt', () => {
    const result = textAIConfigSchema.safeParse({
      type: 'text_generation',
      enabled: true,
      auto_update: false,
      prompt: 'Write a summary of {{description}}',
    })
    expect(result.success).toBe(true)
  })

  it('accepts summarize with source_field_id', () => {
    expect(textAIConfigSchema.safeParse({
      type: 'summarize',
      enabled: true,
      auto_update: false,
      source_field_id: 7,
    }).success).toBe(true)
  })

  it('accepts translate with target_language', () => {
    expect(textAIConfigSchema.safeParse({
      type: 'translate',
      enabled: true,
      auto_update: false,
      source_field_id: 7,
      target_language: 'zh',
    }).success).toBe(true)
  })

  it('rejects classify with fewer than 2 categories', () => {
    expect(textAIConfigSchema.safeParse({
      type: 'classify',
      enabled: true,
      auto_update: false,
      source_field_id: 7,
      categories: ['only one'],
    }).success).toBe(false)
  })

  it('accepts extract with source_field_id', () => {
    expect(textAIConfigSchema.safeParse({
      type: 'extract',
      enabled: true,
      auto_update: false,
      source_field_id: 7,
    }).success).toBe(true)
  })

  it('accepts customize with prompt', () => {
    expect(textAIConfigSchema.safeParse({
      type: 'customize',
      enabled: true,
      auto_update: false,
      prompt: 'Add an emoji to {{title}}',
    }).success).toBe(true)
  })
})

describe('getAIConfigSchemaForField', () => {
  it('returns attachment schema for attachment type', () => {
    expect(getAIConfigSchemaForField('attachment')).toBe(attachmentAIConfigSchema)
  })

  it('returns text schema for text and long_text', () => {
    expect(getAIConfigSchemaForField('text')).toBe(textAIConfigSchema)
    expect(getAIConfigSchemaForField('long_text')).toBe(textAIConfigSchema)
  })

  it('returns null for unsupported types', () => {
    expect(getAIConfigSchemaForField('number')).toBeNull()
    expect(getAIConfigSchemaForField('checkbox')).toBeNull()
  })
})

describe('type guards', () => {
  it('isAttachmentAIConfig returns true for image_generation and image_customization', () => {
    expect(isAttachmentAIConfig({
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 1,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    })).toBe(true)
    expect(isAttachmentAIConfig({
      type: 'image_customization',
      enabled: true,
      auto_update: false,
      prompt: 'x',
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    })).toBe(true)
  })

  it('isAttachmentAIConfig returns false for text configs and undefined', () => {
    expect(isAttachmentAIConfig(undefined)).toBe(false)
    expect(isAttachmentAIConfig({
      type: 'text_generation',
      enabled: true,
      auto_update: false,
      prompt: 'x',
    })).toBe(false)
  })

  it('isTextAIConfig returns true for each text action type', () => {
    const actions = ['text_generation', 'summarize', 'extract', 'translate', 'classify', 'customize'] as const
    for (const type of actions) {
      const config = {
        type,
        enabled: true,
        auto_update: false,
        prompt: 'x',
        source_field_id: 1,
        target_language: 'en',
        categories: ['a', 'b'],
      } as any
      expect(isTextAIConfig(config)).toBe(true)
    }
  })

  it('isTextAIConfig returns false for attachment configs and undefined', () => {
    expect(isTextAIConfig(undefined)).toBe(false)
    expect(isTextAIConfig({
      type: 'image_generation',
      enabled: true,
      auto_update: false,
      source_field_id: 1,
      n: 1,
      quality: 'medium',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_use_case: 'inline_illustration',
    })).toBe(false)
  })
})
