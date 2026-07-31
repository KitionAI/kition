import { describe, expect, it } from 'vitest'

import type { AnyAIConfig } from '@/types/aiConfig'
import type { DataField, DataRecord } from '@/types/dataDocument'
import {
  hasAIFieldPromptPlaceholders,
  materializeAIFieldPrompt,
} from './aiPromptInterpolation'

const fields = [
  { id: 1, name: 'key_message', title: 'Key Message', type: 'long_text' },
  { id: 2, name: 'face_photo', title: 'Face Photo', type: 'attachment' },
  { id: 3, name: 'thumbnail_title', title: 'Thumbnail Title', type: 'long_text' },
  { id: 4, name: 'featured', title: 'Featured', type: 'checkbox' },
] as DataField[]

const record = {
  values: {
    key_message: 'I survived 50 hours in a desert',
    face_photo: [{ name: 'face.png', url: '/face.png' }],
    thumbnail_title: '50 Hours Desert Survival',
    featured: true,
  },
} as unknown as DataRecord

function config(prompt: string): AnyAIConfig {
  return {
    type: 'image_customization',
    enabled: true,
    auto_update: false,
    prompt,
    n: 1,
    quality: 'high',
    aspect_ratio: '16:9',
    resolution: '1K',
    image_use_case: 'cover_illustration',
  }
}

describe('AI prompt interpolation', () => {
  it('expands field-name and field-title placeholders before execution', () => {
    const result = materializeAIFieldPrompt(
      config('Message: {{key_message}}. Title: {{ Thumbnail Title }}.'),
      record,
      fields,
    )

    expect(result).toMatchObject({
      prompt: 'Message: I survived 50 hours in a desert. Title: 50 Hours Desert Survival.',
    })
  })

  it('describes attachment inputs without leaking URLs or placeholder syntax', () => {
    const result = materializeAIFieldPrompt(
      config('Use {{face_photo}}. Featured: {{featured}}. Unknown: {{missing_field}}.'),
      record,
      fields,
    )

    expect(result).toMatchObject({
      prompt: 'Use the attached reference image. Featured: Yes. Unknown: not provided.',
    })
    expect(result && 'prompt' in result ? result.prompt : '').not.toContain('/face.png')
  })

  it('detects prompt configs that require per-record materialization', () => {
    expect(hasAIFieldPromptPlaceholders(config('Use {{key_message}}'))).toBe(true)
    expect(hasAIFieldPromptPlaceholders(config('Use the attached image'))).toBe(false)
  })
})
