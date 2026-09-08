import { describe, expect, it } from 'vitest'

import {
  buildImagePrompt,
  filterImagePromptTemplates,
  getImagePromptTemplate,
  getMissingRequiredImagePromptVariables,
  getRecommendedImagePromptTemplateIds,
  IMAGE_PROMPT_TEMPLATES,
} from './imagePromptTemplates'

describe('image prompt templates', () => {
  it('ships a distinctive visual library with local previews and clear edit templates', () => {
    expect(IMAGE_PROMPT_TEMPLATES).toHaveLength(16)
    expect(new Set(IMAGE_PROMPT_TEMPLATES.map((item) => item.id)).size).toBe(16)
    expect(IMAGE_PROMPT_TEMPLATES.every((item) => item.thumbnail.endsWith('.webp'))).toBe(true)
    expect(IMAGE_PROMPT_TEMPLATES.filter((item) => item.operation === 'edit')).toHaveLength(6)
    expect(IMAGE_PROMPT_TEMPLATES.every((item) => (
      item.source.repository === 'freestylefly/awesome-gpt-image-2'
        && item.source.license === 'MIT'
    ))).toBe(true)
  })

  it('keeps editable overlay copy out of the generated bitmap', () => {
    const prompt = buildImagePrompt({
      aspectRatio: '3:4',
      exactText: 'WRITE WITH CLARITY',
      quality: 'high',
      resolution: '2K',
      templateId: 'surreal-city-poster',
      textMode: 'editable_overlay',
      variables: {
        subject: 'A calm future writing city',
        palette: 'warm cream and forest green',
      },
    })

    expect(prompt).toContain('do not render readable words')
    expect(prompt).toContain('WRITE WITH CLARITY')
    expect(prompt).toContain('A calm future writing city')
    expect(prompt).toContain('3:4')
  })

  it('validates only the few variables a visual template requires', () => {
    const template = getImagePromptTemplate('engineering-infographic')

    expect(getMissingRequiredImagePromptVariables(template, {})).toEqual(['subject'])
    expect(getMissingRequiredImagePromptVariables(template, {
      subject: 'An electric city bus',
    })).toEqual([])
  })

  it('preserves the authorized reference boundary for edit templates', () => {
    const template = getImagePromptTemplate('mixed-media-memory-card')
    const prompt = buildImagePrompt({
      aspectRatio: template.defaultAspectRatio,
      quality: 'medium',
      resolution: '1K',
      templateId: template.id,
      textMode: template.defaultTextMode,
      variables: { details: 'Emphasize the quiet reading moment.' },
    })

    expect(template.operation).toBe('edit')
    expect(prompt).toContain('authorized reference photo')
    expect(prompt).toContain('Keep the original photo unchanged')
    expect(template.source.url).toContain('/blob/main/docs/gallery-part-2.md#case-541')
  })

  it('recommends visual transformations for an image and filters categories', () => {
    const recommendedIds = getRecommendedImagePromptTemplateIds({
      hasReferenceImage: true,
      hasSelectionText: false,
    })

    expect(recommendedIds).toHaveLength(6)
    expect(filterImagePromptTemplates({ recommendedIds, view: 'edit' })).toHaveLength(6)
    expect(filterImagePromptTemplates({
      category: 'poster',
      recommendedIds,
      view: 'all',
    }).every((template) => template.category === 'poster')).toBe(true)
  })
})
