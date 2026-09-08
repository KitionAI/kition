import type { Bounds, DesignDocument, DesignNode, Matrix } from './designTypes'
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export function inverse(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(d) < 1e-8) throw new Error('Invalid transform')
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ]
}
export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export function point(m: Matrix, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}
export function parentNode(doc: DesignDocument, id: string) {
  return Object.values(doc.nodes).find((n) => n.children.includes(id))
}
export function worldMatrix(doc: DesignDocument, id: string): Matrix {
  const node = doc.nodes[id]
  if (!node) return identity()
  const parent = parentNode(doc, id)
  return multiply(
    parent ? worldMatrix(doc, parent.id) : identity(),
    node.transform,
  )
}
export function nodeBounds(node: DesignNode, matrix = node.transform): Bounds {
  const pts = [
    [0, 0],
    [node.width, 0],
    [node.width, node.height],
    [0, node.height],
  ].map(([x, y]) => point(matrix, x, y))
  const x = Math.min(...pts.map((p) => p.x)),
    y = Math.min(...pts.map((p) => p.y))
  return {
    x,
    y,
    width: Math.max(...pts.map((p) => p.x)) - x,
    height: Math.max(...pts.map((p) => p.y)) - y,
  }
}
export function unionBounds(bounds: Bounds[]): Bounds {
  if (!bounds.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...bounds.map((b) => b.x)),
    y = Math.min(...bounds.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y,
  }
}
export function selectionBounds(doc: DesignDocument, ids: string[]): Bounds {
  return unionBounds(
    ids
      .filter((id) => doc.nodes[id])
      .map((id) => {
        const node = doc.nodes[id]
        return node.type === 'group' && node.children.length
          ? selectionBounds(doc, node.children)
          : nodeBounds(node, worldMatrix(doc, id))
      }),
  )
}
export function topSelection(doc: DesignDocument, ids: string[]): string[] {
  return ids.filter((id) => {
    if (!doc.nodes[id]) return false
    let parent = parentNode(doc, id)
    while (parent) {
      if (ids.includes(parent.id)) return false
      parent = parentNode(doc, parent.id)
    }
    return true
  })
}
export function isNodeLocked(doc: DesignDocument, id: string): boolean {
  const parent = parentNode(doc, id)
  return !!doc.nodes[id]?.locked || (!!parent && isNodeLocked(doc, parent.id))
}
export function around(bounds: Bounds, matrix: Matrix): Matrix {
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2
  return multiply(translation(x, y), multiply(matrix, translation(-x, -y)))
}
