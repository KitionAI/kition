import { describe, expect, it } from 'vitest'

import type { DataField, DataRecord } from '@/types/dataDocument'
import {
  canRunAutoAIField,
  getAutoUpdateAIFieldPlan,
  getCreateTimeAIFieldPlan,
} from './aiFieldDependencies'

function field(
  id: number,
  name: string,
  overrides: Partial<DataField> = {},
): DataField {
  return {
    id,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    name,
    title: name,
    type: 'long_text',
    required: false,
    unique: false,
    readonly: false,
    is_primary: false,
    order: id,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

const fields: DataField[] = [
  field(1, 'key_message', { required: true }),
  field(2, 'face_photo', { type: 'attachment', required: true }),
  field(3, 'content_type', { type: 'single_select', required: true }),
  field(4, 'core_emotion', { type: 'single_select', required: true }),
  field(5, 'thumbnail_title_16_9', {
    ai_config: {
      type: 'customize',
      enabled: true,
      auto_update: true,
      prompt: '{{key_message}} {{content_type}} {{core_emotion}}',
    },
  }),
  field(6, 'thumbnail_title_9_16', {
    ai_config: {
      type: 'customize',
      enabled: true,
      auto_update: true,
      prompt: '{{key_message}} {{content_type}} {{core_emotion}}',
    },
  }),
  field(7, 'thumbnail_layout', { type: 'single_select' }),
  field(8, 'hook_strength', { type: 'single_select' }),
  field(9, 'thumbnail_16_9', {
    type: 'attachment',
    ai_config: {
      type: 'image_customization',
      enabled: true,
      auto_update: true,
      source_field_id: 2,
      prompt: '{{face_photo}} {{thumbnail_title_16_9}} {{content_type}} {{core_emotion}} {{thumbnail_layout}} {{hook_strength}}',
      n: 3,
      quality: 'medium',
      aspect_ratio: '16:9',
      resolution: '1K',
      image_use_case: 'cover_illustration',
    },
  }),
  field(10, 'thumbnail_9_16', {
    type: 'attachment',
    ai_config: {
      type: 'image_customization',
      enabled: true,
      auto_update: true,
      source_field_id: 2,
      prompt: '{{face_photo}} {{thumbnail_title_9_16}} {{content_type}} {{core_emotion}} {{thumbnail_layout}} {{hook_strength}}',
      n: 3,
      quality: 'medium',
      aspect_ratio: '9:16',
      resolution: '2K',
      image_use_case: 'cover_illustration',
    },
  }),
]

function record(values: DataRecord['values']): DataRecord {
  return {
    id: 1,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    row_key: 'row-1',
    order: 1,
    values,
    created_at: '',
    updated_at: '',
  }
}

describe('AI field dependencies', () => {
  it('orders title generation before dependent image generation', () => {
    expect(getCreateTimeAIFieldPlan(fields).fields.map((item) => item.id)).toEqual([5, 6, 9, 10])
    expect(getAutoUpdateAIFieldPlan(fields, [3]).fields.map((item) => item.id)).toEqual([5, 6, 9, 10])
  })

  it('waits for required inputs and upstream AI output', () => {
    const initial = record({
      key_message: 'Build faster',
      face_photo: [{ name: 'face.png', url: '/face.png' }],
      content_type: 'How-to & Education',
      core_emotion: 'Confident',
    })
    expect(canRunAutoAIField(initial, fields[4], fields)).toBe(true)
    expect(canRunAutoAIField(initial, fields[8], fields)).toBe(false)

    const withTitle = record({
      ...initial.values,
      thumbnail_title_16_9: 'Build Faster Today',
    })
    expect(canRunAutoAIField(withTitle, fields[8], fields)).toBe(true)
  })

  it('supports an AI-generated attachment as a downstream image reference', () => {
    const productFields = [
      field(1, 'concept_description'),
      field(2, 'designs', {
        type: 'attachment',
        ai_config: {
          type: 'image_generation',
          enabled: true,
          auto_update: true,
          source_field_id: 1,
          n: 2,
          quality: 'high',
          aspect_ratio: '4:3',
          resolution: '1K',
          image_use_case: 'product_showcase',
        },
      }),
      field(3, 'orthographic_views', {
        type: 'attachment',
        ai_config: {
          type: 'image_customization',
          enabled: true,
          auto_update: true,
          source_field_id: 2,
          prompt: 'Preserve the attached product design.',
          n: 1,
          quality: 'high',
          aspect_ratio: '16:9',
          resolution: '1K',
          image_use_case: 'product_showcase',
        },
      }),
    ]

    expect(getCreateTimeAIFieldPlan(productFields).fields.map((item) => item.id)).toEqual([2, 3])
    expect(canRunAutoAIField(
      record({ concept_description: 'A folding reading lamp' }),
      productFields[2],
      productFields,
    )).toBe(false)
    expect(canRunAutoAIField(
      record({
        concept_description: 'A folding reading lamp',
        designs: [{ name: 'design.png', url: '/design.png' }],
      }),
      productFields[2],
      productFields,
    )).toBe(true)
  })

  it('reports cycles instead of executing them', () => {
    const cyclicFields = [
      field(1, 'key_message'),
      field(2, 'title_a', {
        ai_config: {
          type: 'customize',
          enabled: true,
          auto_update: true,
          prompt: '{{key_message}} {{title_b}}',
        },
      }),
      field(3, 'title_b', {
        ai_config: {
          type: 'customize',
          enabled: true,
          auto_update: true,
          prompt: '{{title_a}}',
        },
      }),
    ]
    const plan = getAutoUpdateAIFieldPlan(cyclicFields, [1])
    expect(plan.fields).toEqual([])
    expect(plan.cyclicFieldIds).toEqual([2, 3])
  })
})
