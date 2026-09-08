import {
  createDesignNode,
  designId,
  type DesignDocument,
  type DesignNode,
  type Matrix,
} from './designTypes'
import {
  inverse,
  isNodeLocked,
  multiply,
  parentNode,
  selectionBounds,
  topSelection,
  translation,
  worldMatrix,
} from './designGeometry'
import { validateDesign } from './designSerialization'
export type DesignCommand =
  | { type: 'insert'; nodes: DesignNode[] }
  | {
      type: 'patch'
      ids: string[]
      patch: Partial<Omit<DesignNode, 'id' | 'type' | 'children'>>
    }
  | { type: 'transform'; ids: string[]; matrix: Matrix }
  | { type: 'align'; ids: string[]; axis: 'x' | 'y' }
  | { type: 'remove' | 'group' | 'ungroup' | 'duplicate'; ids: string[] }
  | { type: 'reorder'; id: string; direction: -1 | 1 }
  | {
      type: 'page'
      patch: Partial<
        Pick<DesignDocument['pages'][0], 'width' | 'height' | 'background'>
      >
    }
function siblings(doc: DesignDocument, id: string) {
  return parentNode(doc, id)?.children || doc.pages[0].children
}
function remove(doc: DesignDocument, id: string) {
  const children = [...doc.nodes[id].children]
  const list = siblings(doc, id)
  list.splice(list.indexOf(id), 1)
  for (const child of children) remove(doc, child)
  delete doc.nodes[id]
}
export function duplicateNodes(
  doc: DesignDocument,
  ids: string[],
  offset = 24,
): { nodes: DesignNode[]; roots: string[] } {
  const nodes: DesignNode[] = [],
    roots: string[] = []
  function copy(id: string, root: boolean): string {
    const node = structuredClone(doc.nodes[id])
    node.id = designId()
    if (root)
      node.transform = multiply(
        translation(offset, offset),
        worldMatrix(doc, id),
      )
    node.children = node.children.map((child) => copy(child, false))
    nodes.push(node)
    return node.id
  }
  for (const id of topSelection(doc, ids)) roots.push(copy(id, true))
  return { nodes, roots }
}
export function applyDesignCommand(
  source: DesignDocument,
  command: DesignCommand,
): DesignDocument {
  const doc = structuredClone(source)
  if (command.type === 'page') Object.assign(doc.pages[0], command.patch)
  else if (command.type === 'insert') {
    const children = new Set(command.nodes.flatMap((n) => n.children))
    for (const n of command.nodes) {
      if (doc.nodes[n.id]) throw new Error('Duplicate layer ID')
      doc.nodes[n.id] = structuredClone(n)
    }
    doc.pages[0].children.push(
      ...command.nodes.filter((n) => !children.has(n.id)).map((n) => n.id),
    )
  } else if (command.type === 'reorder') {
    if (!doc.nodes[command.id]) return source
    const list = siblings(doc, command.id),
      index = list.indexOf(command.id),
      target = Math.min(list.length - 1, Math.max(0, index + command.direction))
    list.splice(index, 1)
    list.splice(target, 0, command.id)
  } else {
    const ids = topSelection(doc, command.ids).filter(
      (id) =>
        (command.type === 'patch' &&
          ('locked' in command.patch || 'visible' in command.patch)) ||
        !isNodeLocked(doc, id),
    )
    if (command.type === 'patch')
      for (const id of ids) Object.assign(doc.nodes[id], command.patch)
    if (command.type === 'align')
      for (const id of ids) {
        const b = selectionBounds(doc, [id]),
          page = doc.pages[0]
        const delta =
          command.axis === 'x'
            ? translation(page.width / 2 - b.x - b.width / 2, 0)
            : translation(0, page.height / 2 - b.y - b.height / 2)
        const parent = parentNode(doc, id),
          p = parent
            ? worldMatrix(doc, parent.id)
            : ([1, 0, 0, 1, 0, 0] as Matrix)
        doc.nodes[id].transform = multiply(
          inverse(p),
          multiply(delta, worldMatrix(doc, id)),
        )
      }
    if (command.type === 'transform')
      for (const id of ids) {
        const parent = parentNode(doc, id),
          p = parent
            ? worldMatrix(doc, parent.id)
            : ([1, 0, 0, 1, 0, 0] as Matrix)
        doc.nodes[id].transform = multiply(
          inverse(p),
          multiply(command.matrix, worldMatrix(doc, id)),
        )
      }
    if (command.type === 'remove') for (const id of ids) remove(doc, id)
    if (command.type === 'duplicate') {
      const copied = duplicateNodes(doc, ids)
      for (const n of copied.nodes) doc.nodes[n.id] = n
      doc.pages[0].children.push(...copied.roots)
    }
    if (command.type === 'group' && ids.length > 1) {
      const parent = parentNode(doc, ids[0])
      if (ids.some((id) => parentNode(doc, id)?.id !== parent?.id))
        return source
      const list = siblings(doc, ids[0]),
        ordered = list.filter((id) => ids.includes(id))
      const bounds = selectionBounds(doc, ids),
        group = createDesignNode('group', {
          name: 'Group',
          width: Math.max(1, bounds.width),
          height: Math.max(1, bounds.height),
        })
      const groupWorld = translation(bounds.x, bounds.y)
      group.transform = multiply(
        inverse(parent ? worldMatrix(doc, parent.id) : [1, 0, 0, 1, 0, 0]),
        groupWorld,
      )
      for (const id of ordered)
        doc.nodes[id].transform = multiply(
          inverse(groupWorld),
          worldMatrix(source, id),
        )
      const index = list.indexOf(ordered[0])
      list.splice(0, list.length, ...list.filter((id) => !ids.includes(id)))
      list.splice(index, 0, group.id)
      group.children = ordered
      doc.nodes[group.id] = group
    }
    if (command.type === 'ungroup')
      for (const id of ids) {
        const group = doc.nodes[id]
        if (group.type !== 'group' || group.opacity !== 1) continue
        const list = siblings(doc, id),
          index = list.indexOf(id)
        for (const child of group.children) {
          doc.nodes[child].transform = multiply(
            group.transform,
            doc.nodes[child].transform,
          )
          doc.nodes[child].visible = doc.nodes[child].visible && group.visible
        }
        list.splice(index, 1, ...group.children)
        delete doc.nodes[id]
      }
  }
  if (JSON.stringify(doc) === JSON.stringify(source)) return source
  doc.revision = source.revision + 1
  return validateDesign(doc)
}
