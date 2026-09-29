import { inverse, isNodeLocked, multiply, parentNode, topSelection, worldMatrix } from './designGeometry'
import { validateDesignTransform } from './designSerialization'
import type { DesignDocument, Matrix } from './designTypes'

/** A gesture changes only transforms; validate those without cloning the entire document each frame. */
export function previewDesignTransform(source: DesignDocument, ids: string[], matrix: Matrix): DesignDocument {
  const nodes = { ...source.nodes }
  let changed = false
  for (const id of topSelection(source, ids).filter((id) => !isNodeLocked(source, id))) {
    const node = source.nodes[id]
    const parent = parentNode(source, id)
    const parentMatrix: Matrix = parent ? worldMatrix(source, parent.id) : [1, 0, 0, 1, 0, 0]
    const transform = validateDesignTransform(
      multiply(inverse(parentMatrix), multiply(matrix, worldMatrix(source, id))),
    )
    if (transform.every((value, index) => value === node.transform[index])) continue
    nodes[id] = { ...node, transform }
    changed = true
  }
  return changed ? { ...source, nodes, revision: source.revision + 1 } : source
}
