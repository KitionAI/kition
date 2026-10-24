import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { getBuiltinDocumentTemplates } from './documentTemplates'

const t = ((key: string) => key) as TFunction<'document'>

describe('built-in document templates', () => {
  it('ships exactly 20 distinct templates across three categories', () => {
    const templates = getBuiltinDocumentTemplates(t)

    expect(templates).toHaveLength(20)
    expect(new Set(templates.map((template) => template.id)).size).toBe(20)
    expect(new Set(templates.map((template) => template.preview)).size).toBe(20)
    expect(new Set(templates.map((template) => template.coverImage)).size).toBe(20)
    expect(templates.every((template) => (
      template.coverImage === `kition-bundled:/templates/document-covers/${template.id}.webp`
    ))).toBe(true)
    expect(new Set(templates.map((template) => template.category))).toEqual(
      new Set(['work', 'planning', 'personal']),
    )
  })

  it('includes editable Mermaid templates for the visual document formats', () => {
    const templates = getBuiltinDocumentTemplates(t)
    const diagramIds = [
      'flowchart',
      'project-timeline',
      'organization-chart',
      'system-architecture',
      'product-development-swimlane',
    ]

    for (const id of diagramIds) {
      const template = templates.find((item) => item.id === id)
      expect(template?.content).toContain('```mermaid')
      expect(template?.content).toContain('# {{title}}')
    }

    expect(templates.find((item) => item.id === 'flowchart')?.content).toContain(
      'account{Existing account?}',
    )
  })
})
