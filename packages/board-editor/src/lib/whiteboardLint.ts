import { isBoardFrameElement } from './boardHierarchy'
import type { BoardBindingRecord } from './boardRecords'
import { getWhiteboardElementBounds, whiteboardBoundsIntersect } from './whiteboardGeometry'
import type { WhiteboardElement } from './whiteboardTypes'

export type WhiteboardLintFinding = {
  code: 'disconnected-node' | 'missing-label' | 'outside-frame' | 'overlapping-label'
  elementIds: string[]
  severity: 'warning'
}

export function lintWhiteboard(input: {
  bindings?: readonly BoardBindingRecord[]
  elements: readonly WhiteboardElement[]
}) {
  const findings: WhiteboardLintFinding[] = []
  const byId = new Map(input.elements.map((element) => [element.id, element]))
  const connectedIds = new Set((input.bindings || []).flatMap((binding) => (
    binding.binding_type === 'connector' ? [binding.from_id, binding.to_id] : []
  )))

  for (const element of input.elements) {
    if (element.kind === 'rectangle' && (
      element.shapeStyle === 'flow-node' || element.shapeStyle === 'mind-node'
    )) {
      if (!element.text?.trim()) findings.push(finding('missing-label', [element.id]))
      if (element.shapeStyle === 'flow-node' && !connectedIds.has(element.id)) {
        findings.push(finding('disconnected-node', [element.id]))
      }
    }
    if (element.parentId) {
      const parent = byId.get(element.parentId)
      if (isBoardFrameElement(parent) && !boundsContain(
        getWhiteboardElementBounds(parent),
        getWhiteboardElementBounds(element),
      )) findings.push(finding('outside-frame', [element.id, parent.id]))
    }
  }

  const labels = input.elements.filter((element) => (
    element.kind === 'text' && element.text.trim()
  ))
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      if (whiteboardBoundsIntersect(
        getWhiteboardElementBounds(labels[left]),
        getWhiteboardElementBounds(labels[right]),
      )) findings.push(finding('overlapping-label', [labels[left].id, labels[right].id]))
    }
  }
  return findings
}

function finding(
  code: WhiteboardLintFinding['code'],
  elementIds: string[],
): WhiteboardLintFinding {
  return { code, elementIds, severity: 'warning' }
}

function boundsContain(
  outer: ReturnType<typeof getWhiteboardElementBounds>,
  inner: ReturnType<typeof getWhiteboardElementBounds>,
) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
}
