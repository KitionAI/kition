import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import { cloneBoardElement } from '../lib/boardRecords'
import type { BoardHistoryMark, BoardStore } from '../lib/boardStore'
import { createWhiteboardElementId } from '../lib/whiteboardElementId'
import { translateWhiteboardElement } from '../lib/whiteboardGeometry'
import {
  getWhiteboardElementStyle,
  normalizeWhiteboardStyle,
} from '../lib/whiteboardStyle'
import type {
  WhiteboardElement,
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
  setTool: Dispatch<SetStateAction<WhiteboardTool>>
  store: BoardStore
  tool: WhiteboardTool
  viewport: WhiteboardViewport
}) {
  const eraseMarkRef = useRef<BoardHistoryMark | null>(null)

  const duplicateSelection = useCallback(() => {
    const duplicable = input.selectedElements.filter((element) => !element.locked)
    if (duplicable.length === 0) return false
    const duplicates = duplicable.map((element) => translateWhiteboardElement({
      ...cloneBoardElement(element),
      id: createWhiteboardElementId(element.kind),
      locked: false,
    }, { x: 24, y: 24 }))
    input.commands.execute({ type: 'element.create', elements: duplicates })
    input.replaceSelection(duplicates.map((element) => element.id))
    return true
  }, [input.commands, input.replaceSelection, input.selectedElements])

  const applyStyle = useCallback((patch: Partial<WhiteboardElementStyle>) => {
    const editable = input.selectedElements.filter((element) => !element.locked)
    if (editable.length === 0) {
      input.setDefaultStyle((current) => normalizeWhiteboardStyle({ ...current, ...patch }))
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
  }, [input.commands, input.selectedElements, input.setDefaultStyle])

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
    const element: WhiteboardElement = {
      id: createWhiteboardElementId('image'),
      kind: 'image',
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
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
    input.replaceSelection,
    input.setTool,
    input.viewport,
  ])

  return {
    applyStyle,
    beginErase,
    continueErase,
    duplicateSelection,
    endErase,
    insertImage,
  }
}
