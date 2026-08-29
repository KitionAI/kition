import {
  boardElementFromRecord,
  cloneBoardElement,
  createBoardElementRecord,
  type BoardElementRecord,
} from './boardRecords'
import { createWhiteboardElementId } from './whiteboardElementId'
import {
  getWhiteboardElementBounds,
  translateWhiteboardElement,
} from './whiteboardGeometry'
import type { WhiteboardElement, WhiteboardPoint } from './whiteboardTypes'

export type BoardContainerKind = 'group' | 'frame'

export function isBoardGroupElement(
  element: WhiteboardElement | undefined,
): element is Extract<WhiteboardElement, { kind: 'rectangle' }> {
  return element?.kind === 'rectangle' && element.shapeStyle === 'group'
}

export function isBoardFrameElement(
  element: WhiteboardElement | undefined,
): element is Extract<WhiteboardElement, { kind: 'rectangle' }> {
  return element?.kind === 'rectangle'
    && (element.shapeStyle === 'frame' || element.shapeType === 'frame')
}

export function isBoardContainerElement(
  element: WhiteboardElement | undefined,
): element is Extract<WhiteboardElement, { kind: 'rectangle' }> {
  return isBoardGroupElement(element) || isBoardFrameElement(element)
}

export function getBoardSelectionRootIds(
  elements: readonly WhiteboardElement[],
  elementIds: readonly string[],
) {
  const selectedIds = new Set(elementIds)
  const byId = new Map(elements.map((element) => [element.id, element]))
  return [...selectedIds].filter((id) => {
    let parentId = byId.get(id)?.parentId
    const visited = new Set<string>()
    while (parentId && !visited.has(parentId)) {
      if (selectedIds.has(parentId)) return false
      visited.add(parentId)
      parentId = byId.get(parentId)?.parentId
    }
    return true
  })
}

export function getBoardElementsWithDescendants(
  elements: readonly WhiteboardElement[],
  rootIds: readonly string[],
) {
  const normalizedRoots = new Set(getBoardSelectionRootIds(elements, rootIds))
  const byId = new Map(elements.map((element) => [element.id, element]))
  return elements.filter((element) => {
    let current: WhiteboardElement | undefined = element
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      if (normalizedRoots.has(current.id)) return true
      visited.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return false
  })
}

export function getBoardDescendantIds(
  elements: readonly WhiteboardElement[],
  rootIds: readonly string[],
) {
  const roots = new Set(rootIds)
  return getBoardElementsWithDescendants(elements, rootIds)
    .filter((element) => !roots.has(element.id))
    .map((element) => element.id)
}

export function resolveBoardSelectableElementId(
  elements: readonly WhiteboardElement[],
  elementId: string,
) {
  const byId = new Map(elements.map((element) => [element.id, element]))
  let current = byId.get(elementId)
  if (!current) return elementId
  let selectableId = current.id
  const visited = new Set<string>()
  while (current.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId)
    const parent = byId.get(current.parentId)
    if (!isBoardGroupElement(parent)) break
    selectableId = parent.id
    current = parent
  }
  return selectableId
}

export function cloneBoardElementTrees(
  elements: readonly WhiteboardElement[],
  rootIds: readonly string[],
) {
  const treeElements = getBoardElementsWithDescendants(elements, rootIds)
  const treeIds = new Set(treeElements.map((element) => element.id))
  const idMap = new Map(treeElements.map((element) => [
    element.id,
    createWhiteboardElementId(element.kind),
  ]))
  return {
    elements: treeElements.map((element) => ({
      ...cloneBoardElement(element),
      id: idMap.get(element.id)!,
      locked: false,
      parentId: element.parentId && treeIds.has(element.parentId)
        ? idMap.get(element.parentId)
        : element.parentId,
    })),
    rootIds: getBoardSelectionRootIds(elements, rootIds).map((id) => idMap.get(id)!),
  }
}

export function applyBoardRootTranslations(
  elements: readonly WhiteboardElement[],
  roots: readonly WhiteboardElement[],
  translatedRoots: readonly WhiteboardElement[],
) {
  const translatedById = new Map(translatedRoots.map((element) => [element.id, element]))
  const updates = new Map<string, WhiteboardElement>()
  for (const root of roots) {
    const translatedRoot = translatedById.get(root.id)
    if (!translatedRoot) continue
    const beforeBounds = getWhiteboardElementBounds(root)
    const afterBounds = getWhiteboardElementBounds(translatedRoot)
    const delta = {
      x: afterBounds.x - beforeBounds.x,
      y: afterBounds.y - beforeBounds.y,
    }
    for (const element of getBoardElementsWithDescendants(elements, [root.id])) {
      updates.set(element.id, element.id === root.id
        ? translatedRoot
        : translateWhiteboardElement(element, delta))
    }
  }
  return elements.flatMap((element) => {
    const update = updates.get(element.id)
    return update ? [update] : []
  })
}

export function getBoardFrameAtPoint(
  elements: readonly WhiteboardElement[],
  point: WhiteboardPoint,
  excludedIds: ReadonlySet<string> = new Set(),
) {
  return elements
    .filter((element) => isBoardFrameElement(element) && !excludedIds.has(element.id))
    .map((element) => ({ element, bounds: getWhiteboardElementBounds(element) }))
    .filter(({ bounds }) => (
      point.x >= bounds.x
      && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y
      && point.y <= bounds.y + bounds.height
    ))
    .sort((left, right) => (
      left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height
    ))[0]?.element
}

export function repairBoardHierarchyRecords(
  records: readonly BoardElementRecord[],
) {
  const byId = new Map(records.map((record) => [record.id, record]))
  return records.map((record) => {
    if (!record.parentId) return record
    const parent = byId.get(record.parentId)
    if (
      !parent
      || parent.id === record.id
      || parent.page_id !== record.page_id
      || !isBoardContainerElement(boardElementFromRecord(parent))
      || createsHierarchyCycle(record.id, parent.id, byId)
    ) {
      return createBoardElementRecord({
        element: { ...boardElementFromRecord(record), parentId: undefined },
        index: record.index,
        pageId: record.page_id,
      })
    }
    return record
  })
}

function createsHierarchyCycle(
  childId: string,
  parentId: string,
  byId: ReadonlyMap<string, BoardElementRecord>,
) {
  let currentId: string | undefined = parentId
  const visited = new Set<string>()
  while (currentId && !visited.has(currentId)) {
    if (currentId === childId) return true
    visited.add(currentId)
    currentId = byId.get(currentId)?.parentId
  }
  return false
}
