import { describe, expect, it } from 'vitest'

import {
  instantiateWhiteboardTemplate,
  WHITEBOARD_TEMPLATES,
} from './whiteboardTemplates'

const resolveText = (key: string) => `copy:${key}`

describe('whiteboard templates', () => {
  it('provides six distinct editable starting structures', () => {
    expect(WHITEBOARD_TEMPLATES.map((template) => template.id)).toEqual([
      'mind-map',
      'flowchart',
      'project-roadmap',
      'kanban-board',
      'meeting-retrospective',
      'presentation-storyboard',
    ])

    for (const template of WHITEBOARD_TEMPLATES) {
      const instance = instantiateWhiteboardTemplate(
        template.id,
        { x: 800, y: 600 },
        resolveText,
      )
      const ids = instance.elements.map((element) => element.id)
      const idSet = new Set(ids)
      const root = instance.elements.find((element) => element.id === instance.rootIds[0])

      expect(idSet.size).toBe(ids.length)
      if (template.id === 'mind-map') {
        expect(instance.rootIds).toHaveLength(1)
        expect(instance.elements.find((element) => element.id === instance.rootIds[0]))
          .toMatchObject({ kind: 'rectangle', text: 'copy:mindMap.topic' })
        expect(instance.elements.some((element) => (
          element.kind === 'rectangle' && element.shapeType === 'frame'
        ))).toBe(false)
      } else {
        expect(root).toMatchObject({
          kind: 'rectangle',
          shapeStyle: 'frame',
          shapeType: 'frame',
          width: template.width,
          height: template.height,
        })
      }
      expect(instance.elements.some((element) => (
        element.kind === 'text'
          || (element.kind === 'rectangle' && Boolean(element.text))
      ))).toBe(true)
      expect(instance.elements.every((element) => {
        if (element.kind === 'rectangle' || element.kind === 'image') {
          return element.width > 0 && element.height > 0
        }
        if (element.kind === 'text') return (element.fontSize || 0) > 0 && element.text.startsWith('copy:')
        if (element.kind === 'stroke') return element.points.length > 0
        return Number.isFinite(element.start.x)
          && Number.isFinite(element.start.y)
          && Number.isFinite(element.end.x)
          && Number.isFinite(element.end.y)
      })).toBe(true)
      expect(instance.elements.every((element) => (
        !element.parentId || idSet.has(element.parentId)
      ))).toBe(true)
    }
  })

  it('creates valid connector bindings and fresh IDs for every insertion', () => {
    for (const template of WHITEBOARD_TEMPLATES) {
      const first = instantiateWhiteboardTemplate(template.id, { x: 800, y: 600 }, resolveText)
      const second = instantiateWhiteboardTemplate(template.id, { x: 800, y: 600 }, resolveText)
      const firstIds = new Set(first.elements.map((element) => element.id))
      const secondIds = new Set(second.elements.map((element) => element.id))

      expect([...firstIds].every((id) => !secondIds.has(id))).toBe(true)
      for (const binding of first.bindings) {
        expect(firstIds.has(binding.from_id)).toBe(true)
        expect(firstIds.has(binding.to_id)).toBe(true)
        expect(first.elements.find((element) => element.id === binding.from_id)?.kind)
          .toBe('connector')
        expect(binding.to_anchor?.x).toBeGreaterThanOrEqual(0)
        expect(binding.to_anchor?.x).toBeLessThanOrEqual(1)
        expect(binding.to_anchor?.y).toBeGreaterThanOrEqual(0)
        expect(binding.to_anchor?.y).toBeLessThanOrEqual(1)
      }
    }
  })

  it('includes connectors in the diagram and timeline templates', () => {
    for (const templateId of ['mind-map', 'flowchart', 'project-roadmap'] as const) {
      const instance = instantiateWhiteboardTemplate(templateId, { x: 800, y: 600 }, resolveText)
      expect(instance.elements.some((element) => element.kind === 'connector')).toBe(true)
      expect(instance.bindings.length).toBeGreaterThan(0)
    }
  })

  it('uses editable top-level nodes and branch lines for the mind map', () => {
    const instance = instantiateWhiteboardTemplate('mind-map', { x: 800, y: 600 }, resolveText)

    expect(instance.elements.every((element) => !element.parentId)).toBe(true)
    expect(instance.elements.filter((element) => element.kind === 'connector').every((element) => (
      element.kind === 'connector'
        && element.connectorRole === 'mind-map-branch'
        && element.connectorType === 'curved'
        && element.mindMapBranchAxis === 'horizontal'
        && element.endArrowhead === 'none'
    ))).toBe(true)
  })
})
