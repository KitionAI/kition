import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type {
  BoardCommandRegistry,
  BoardElementReorderPlacement,
} from '../lib/boardCommands'
import { cloneBoardElement } from '../lib/boardRecords'
import type { BoardHistoryMark, BoardStore } from '../lib/boardStore'
import {
  applyBoardRootTranslations,
  cloneBoardElementTrees,
  getBoardElementsWithDescendants,
  getBoardFrameAtPoint,
  getBoardSelectionRootIds,
  isBoardContainerElement,
  type BoardContainerKind,
} from '../lib/boardHierarchy'
import {
  alignBoardElements,
  distributeBoardElements,
  type BoardAlignment,
  type BoardDistribution,
  stackBoardElements,
  type BoardStackDirection,
} from '../lib/boardLayout'
import {
  createWhiteboardElementId,
  createWhiteboardPageId,
} from '../lib/whiteboardElementId'
import {
  flipWhiteboardElements,
  getWhiteboardSelectionBounds,
  rotateWhiteboardElementsByDegrees,
  translateWhiteboardElement,
} from '../lib/whiteboardGeometry'
import {
  getWhiteboardElementStyle,
  normalizeWhiteboardStyle,
} from '../lib/whiteboardStyle'
import type {
  WhiteboardElement,
  WhiteboardConnectorElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardTool,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'

export function useWhiteboardElementActions(input: {
  clearSelection: () => void
  commands: BoardCommandRegistry
  defaultStyle: WhiteboardElementStyle
  elements: readonly WhiteboardElement[]
  replaceSelection: (ids: string[]) => void
  selectedElementIds: string[]
  selectedElements: readonly WhiteboardElement[]
  setDefaultStyle: Dispatch<SetStateAction<WhiteboardElementStyle>>
  setHighlightStyle: Dispatch<SetStateAction<WhiteboardElementStyle>>
  setTool: Dispatch<SetStateAction<WhiteboardTool>>
  store: BoardStore
  tool: WhiteboardTool
  viewport: WhiteboardViewport
}) {
  const eraseMarkRef = useRef<BoardHistoryMark | null>(null)

  const duplicateSelection = useCallback(() => {
    const rootIds = getBoardSelectionRootIds(
      input.elements,
      input.selectedElements.filter((element) => !element.locked).map((element) => element.id),
    )
    if (rootIds.length === 0) return false
    const cloned = cloneBoardElementTrees(input.elements, rootIds)
    const duplicates = cloned.elements.map((element) => (
      translateWhiteboardElement(element, { x: 24, y: 24 })
    ))
    input.commands.execute({ type: 'element.create', elements: duplicates })
    input.replaceSelection(cloned.rootIds)
    return true
  }, [input.commands, input.elements, input.replaceSelection, input.selectedElements])

  const applyStyle = useCallback((patch: Partial<WhiteboardElementStyle>) => {
    const editable = input.selectedElements.filter((element) => !element.locked)
    if (editable.length === 0) {
      const setStyle = input.tool === 'highlight'
        ? input.setHighlightStyle
        : input.setDefaultStyle
      setStyle((current) => normalizeWhiteboardStyle({ ...current, ...patch }))
      return
    }
    input.commands.execute({
      type: 'element.update',
      elements: editable.map((element) => ({
        ...cloneBoardElement(element),
        style: normalizeWhiteboardStyle({
          ...getWhiteboardElementStyle(element),
          ...patch,
        }),
      })),
    })
  }, [
    input.commands,
    input.selectedElements,
    input.setDefaultStyle,
    input.setHighlightStyle,
    input.tool,
  ])

  const updateSelectedConnectors = useCallback((
    patch: Partial<Pick<WhiteboardConnectorElement,
      'connectorType' | 'startArrowhead' | 'endArrowhead'>>,
  ) => {
    const connectors = input.selectedElements.filter((element): element is WhiteboardConnectorElement => (
      element.kind === 'connector' && !element.locked
    ))
    if (connectors.length === 0) return false
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: connectors.map((element) => ({ ...element, ...patch })),
    }))
  }, [input.commands, input.selectedElements])

  const reorderSelection = useCallback((placement: BoardElementReorderPlacement) => {
    const reorderableIds = input.selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    if (reorderableIds.length === 0) return false
    return Boolean(input.commands.execute({
      type: 'element.reorder',
      elementIds: reorderableIds,
      placement,
    }))
  }, [input.commands, input.selectedElements])

  const alignSelection = useCallback((alignment: BoardAlignment) => {
    const roots = input.selectedElements.filter((element) => !element.locked)
    if (roots.length < 2) return false
    const alignedRoots = alignBoardElements(roots, alignment)
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: applyBoardRootTranslations(input.elements, roots, alignedRoots),
    }))
  }, [input.commands, input.elements, input.selectedElements])

  const distributeSelection = useCallback((distribution: BoardDistribution) => {
    const roots = input.selectedElements.filter((element) => !element.locked)
    if (roots.length < 3) return false
    const distributedRoots = distributeBoardElements(roots, distribution)
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: applyBoardRootTranslations(input.elements, roots, distributedRoots),
    }))
  }, [input.commands, input.elements, input.selectedElements])

  const stackSelection = useCallback((direction: BoardStackDirection) => {
    const roots = input.selectedElements.filter((element) => !element.locked)
    if (roots.length < 2) return false
    const stackedRoots = stackBoardElements(roots, direction)
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: applyBoardRootTranslations(input.elements, roots, stackedRoots),
    }))
  }, [input.commands, input.elements, input.selectedElements])

  const rotateSelection = useCallback((degrees: number) => {
    const rootIds = input.selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    const elements = getBoardElementsWithDescendants(input.elements, rootIds)
    const bounds = getWhiteboardSelectionBounds(elements)
    if (!bounds || elements.length === 0) return false
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: rotateWhiteboardElementsByDegrees({
        elements,
        origin: {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        },
        degrees,
      }),
    }))
  }, [input.commands, input.elements, input.selectedElements])

  const flipSelection = useCallback((direction: 'horizontal' | 'vertical') => {
    const rootIds = input.selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    const elements = getBoardElementsWithDescendants(input.elements, rootIds)
    const bounds = getWhiteboardSelectionBounds(elements)
    if (!bounds || elements.length === 0) return false
    return Boolean(input.commands.execute({
      type: 'element.update',
      elements: flipWhiteboardElements({ elements, bounds, direction }),
    }))
  }, [input.commands, input.elements, input.selectedElements])

  const groupSelection = useCallback((containerKind: BoardContainerKind) => {
    const rootIds = getBoardSelectionRootIds(
      input.elements,
      input.selectedElements.filter((element) => !element.locked).map((element) => element.id),
    )
    if (rootIds.length < (containerKind === 'group' ? 2 : 1)) return false
    const containerId = createWhiteboardElementId('rectangle')
    const diff = input.commands.execute({
      type: 'element.group',
      containerId,
      containerKind,
      elementIds: rootIds,
    })
    if (!diff) return false
    input.replaceSelection([containerId])
    return true
  }, [input.commands, input.elements, input.replaceSelection, input.selectedElements])

  const ungroupSelection = useCallback(() => {
    const containerIds = input.selectedElements
      .filter((element) => isBoardContainerElement(element) && !element.locked)
      .map((element) => element.id)
    if (containerIds.length === 0) return false
    const containerIdSet = new Set(containerIds)
    const childIds = input.elements
      .filter((element) => element.parentId && containerIdSet.has(element.parentId))
      .map((element) => element.id)
    const diff = input.commands.execute({ type: 'element.ungroup', containerIds })
    if (!diff) return false
    input.replaceSelection(childIds)
    return true
  }, [input.commands, input.elements, input.replaceSelection, input.selectedElements])

  const fitFramesToContent = useCallback(() => {
    const updates = input.selectedElements.flatMap((frame): WhiteboardElement[] => {
      if (!isBoardContainerElement(frame) || frame.shapeStyle !== 'frame' || frame.locked) return []
      const descendants = getBoardElementsWithDescendants(input.elements, [frame.id])
        .filter((element) => element.id !== frame.id)
      const bounds = getWhiteboardSelectionBounds(descendants)
      if (!bounds) return []
      return [{
        ...frame,
        x: bounds.x - 32,
        y: bounds.y - 52,
        width: bounds.width + 64,
        height: bounds.height + 84,
      }]
    })
    if (updates.length === 0) return false
    return Boolean(input.commands.execute({ type: 'element.update', elements: updates }))
  }, [input.commands, input.elements, input.selectedElements])

  const createPage = useCallback(() => {
    const pageId = createWhiteboardPageId()
    const pages = input.store.getPages()
    const diff = input.commands.execute({
      type: 'page.create',
      pageId,
      name: `Page ${pages.length + 1}`,
    })
    if (!diff) return false
    input.clearSelection()
    return true
  }, [input.clearSelection, input.commands, input.store])

  const duplicatePage = useCallback((pageId = input.store.getCurrentPageId()) => {
    const source = input.store.getPages().find((page) => page.id === pageId)
    if (!source) return false
    const diff = input.commands.execute({
      type: 'page.duplicate',
      sourcePageId: source.id,
      pageId: createWhiteboardPageId(),
      name: `${source.name} copy`,
    })
    if (!diff) return false
    input.clearSelection()
    return true
  }, [input.clearSelection, input.commands, input.store])

  const activatePage = useCallback((pageId: string) => {
    if (pageId === input.store.getCurrentPageId()) return false
    const diff = input.commands.execute({ type: 'page.activate', pageId })
    if (!diff) return false
    input.clearSelection()
    return true
  }, [input.clearSelection, input.commands, input.store])

  const renamePage = useCallback((pageId: string, name: string) => Boolean(
    input.commands.execute({ type: 'page.rename', pageId, name }),
  ), [input.commands])

  const deletePage = useCallback((pageId = input.store.getCurrentPageId()) => {
    const diff = input.commands.execute({ type: 'page.delete', pageId })
    if (!diff) return false
    input.clearSelection()
    return true
  }, [input.clearSelection, input.commands, input.store])

  const reorderPage = useCallback((
    pageId: string,
    placement: 'previous' | 'next',
  ) => Boolean(input.commands.execute({
    type: 'page.reorder',
    pageId,
    placement,
  })), [input.commands])

  const beginErase = useCallback((elementId?: string) => {
    if (input.tool !== 'eraser') return false
    if (!eraseMarkRef.current) eraseMarkRef.current = input.store.markHistory()
    if (elementId) eraseElement(elementId)
    return true

    function eraseElement(id: string) {
      const element = input.elements.find((item) => item.id === id)
      if (!element || element.locked) return
      input.commands.execute({ type: 'element.delete', elementIds: [id] })
      if (input.selectedElementIds.includes(id)) input.clearSelection()
    }
  }, [
    input.clearSelection,
    input.commands,
    input.elements,
    input.selectedElementIds,
    input.store,
    input.tool,
  ])

  const continueErase = useCallback((elementId: string) => {
    if (!eraseMarkRef.current || input.tool !== 'eraser') return false
    const element = input.elements.find((item) => item.id === elementId)
    if (!element || element.locked) return false
    input.commands.execute({ type: 'element.delete', elementIds: [elementId] })
    if (input.selectedElementIds.includes(elementId)) input.clearSelection()
    return true
  }, [
    input.clearSelection,
    input.commands,
    input.elements,
    input.selectedElementIds,
    input.tool,
  ])

  const endErase = useCallback(() => {
    const mark = eraseMarkRef.current
    eraseMarkRef.current = null
    if (mark) input.store.squashToMark(mark, 'Erase elements')
  }, [input.store])

  const insertImage = useCallback((image: {
    alt?: string
    canvasSize: WhiteboardPoint
    height: number
    width: number
    workspacePath: string
  }) => {
    const width = Math.max(40, Math.min(1200, image.width))
    const height = Math.max(40, Math.min(900, image.height))
    const center = {
      x: input.viewport.x + image.canvasSize.x / input.viewport.zoom / 2,
      y: input.viewport.y + image.canvasSize.y / input.viewport.zoom / 2,
    }
    const frame = getBoardFrameAtPoint(input.elements, center)
    const element: WhiteboardElement = {
      id: createWhiteboardElementId('image'),
      kind: 'image',
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      parentId: frame?.id,
      workspacePath: image.workspacePath,
      alt: image.alt,
      locked: false,
      rotation: 0,
      style: { ...input.defaultStyle },
    }
    input.commands.execute({ type: 'element.create', elements: [element] })
    input.replaceSelection([element.id])
    input.setTool('select')
    return element.id
  }, [
    input.commands,
    input.defaultStyle,
    input.elements,
    input.replaceSelection,
    input.setTool,
    input.viewport,
  ])

  return {
    activatePage,
    applyStyle,
    alignSelection,
    beginErase,
    continueErase,
    createPage,
    deletePage,
    duplicateSelection,
    duplicatePage,
    distributeSelection,
    endErase,
    fitFramesToContent,
    flipSelection,
    insertImage,
    groupSelection,
    renamePage,
    reorderPage,
    reorderSelection,
    rotateSelection,
    stackSelection,
    ungroupSelection,
    updateSelectedConnectors,
  }
}
