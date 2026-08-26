import { useCallback, useMemo, useState } from 'react'

import {
  cloneBoardElement,
  type BoardRecord,
} from '../lib/boardRecords'
import {
  getBoardElementsWithDescendants,
  getBoardFrameAtPoint,
  getBoardSelectionRootIds,
} from '../lib/boardHierarchy'
import { translateWhiteboardElement } from '../lib/whiteboardGeometry'
import { lintWhiteboard } from '../lib/whiteboardLint'
import {
  DEFAULT_WHITEBOARD_HIGHLIGHT_STYLE,
  DEFAULT_WHITEBOARD_STYLE,
  getWhiteboardElementStyle,
} from '../lib/whiteboardStyle'
import type {
  WhiteboardBounds,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardShapeType,
  WhiteboardTool,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'
import { useBoardEditorStore } from './useBoardEditorStore'
import { useWhiteboardCamera } from './useWhiteboardCamera'
import { useWhiteboardClipboard } from './useWhiteboardClipboard'
import { useWhiteboardElementActions } from './useWhiteboardElementActions'
import { useWhiteboardExport } from './useWhiteboardExport'
import { useWhiteboardInteractionMachine } from './useWhiteboardInteractionMachine'
import { useWhiteboardKeyboard } from './useWhiteboardKeyboard'
import { useWhiteboardSelection } from './useWhiteboardSelection'
import { useWhiteboardTextEditing } from './useWhiteboardTextEditing'

export function useWhiteboardEditor() {
  const {
    commands,
    elements,
    records,
    snapshot,
    store,
  } = useBoardEditorStore()
  const {
    actualSize,
    cameraBack,
    cameraForward,
    canCameraBack,
    canCameraForward,
    centerViewportAt,
    fitToContent,
    fitToElements,
    replaceViewport,
    recordViewportHistory,
    setViewport,
    viewport,
    zoomBy,
  } = useWhiteboardCamera(elements)
  const {
    clearSelection,
    replaceSelection,
    selectedElementId,
    selectedElementIds,
    selectedElements,
    setSelectedElementIds,
  } = useWhiteboardSelection(elements)
  const [tool, setTool] = useState<WhiteboardTool>('select')
  const [shapeType, setShapeTypeState] = useState<WhiteboardShapeType>('rectangle')
  const [defaultStyle, setDefaultStyle] = useState<WhiteboardElementStyle>({
    ...DEFAULT_WHITEBOARD_STYLE,
  })
  const [highlightStyle, setHighlightStyle] = useState<WhiteboardElementStyle>({
    ...DEFAULT_WHITEBOARD_HIGHLIGHT_STYLE,
  })
  const { exportPng, exportSvg } = useWhiteboardExport(elements)
  const lintFindings = useMemo(() => lintWhiteboard({
    bindings: records.filter((record) => record.record_type === 'binding'),
    elements,
  }), [elements, records])
  const queryElements = useCallback((bounds: WhiteboardBounds) => (
    store.queryCurrentPageElements(bounds)
  ), [store])
  const getViewportElements = useCallback((size: WhiteboardPoint, overscan = 160) => {
    const worldOverscan = Math.max(0, overscan) / viewport.zoom
    return queryElements({
      x: viewport.x - worldOverscan,
      y: viewport.y - worldOverscan,
      width: size.x / viewport.zoom + worldOverscan * 2,
      height: size.y / viewport.zoom + worldOverscan * 2,
    })
  }, [queryElements, viewport])

  const {
    activeResizeHandle,
    beginCanvasPointer: beginPointerInteraction,
    beginElementPointer,
    beginResizePointer,
    beginRotatePointer,
    cancelInteraction,
    draft,
    endPointer: finishPointerInteraction,
    interactionState: pointerInteractionState,
    movePointer,
    selectElement,
    snapGuides,
  } = useWhiteboardInteractionMachine({
    clearSelection,
    commands,
    defaultStyle,
    elements,
    highlightStyle,
    queryElements,
    replaceSelection,
    recordViewportHistory,
    selectedElementIds,
    selectedElements,
    setSelectedElementIds,
    setTool,
    setViewport,
    shapeType,
    store,
    tool,
    viewport,
  })

  const {
    beginNewTextEdit,
    beginTextEdit,
    cancelEditingText,
    commitEditingText,
    dismissEditingText,
    editingText,
    updateEditingText,
  } = useWhiteboardTextEditing({
    cancelInteraction,
    commands,
    defaultStyle,
    elements,
    replaceSelection,
    setTool,
  })

  const beginCanvasPointer = useCallback((input: {
    world: WhiteboardPoint
    screen: WhiteboardPoint
    additive?: boolean
    targetElementId?: string
  }) => {
    dismissEditingText()
    if (tool === 'text') {
      cancelInteraction()
      beginNewTextEdit(
        input.world,
        getBoardFrameAtPoint(elements, input.world)?.id,
      )
      return
    }
    beginPointerInteraction(input)
  }, [
    beginNewTextEdit,
    beginPointerInteraction,
    cancelInteraction,
    dismissEditingText,
    elements,
    tool,
  ])

  const endPointer = useCallback((world: WhiteboardPoint, targetElementId?: string) => {
    const result = finishPointerInteraction(world, targetElementId)
    if (result.editElement) beginTextEdit(result.editElement)
  }, [beginTextEdit, finishPointerInteraction])

  const clearTransientState = useCallback(() => {
    cancelInteraction()
    clearSelection()
    dismissEditingText()
    setTool('select')
  }, [cancelInteraction, clearSelection, dismissEditingText])

  const undo = useCallback(() => {
    cancelInteraction()
    store.undo()
    clearSelection()
    dismissEditingText()
  }, [cancelInteraction, clearSelection, dismissEditingText, store])

  const redo = useCallback(() => {
    cancelInteraction()
    store.redo()
    clearSelection()
    dismissEditingText()
  }, [cancelInteraction, clearSelection, dismissEditingText, store])

  const deleteSelection = useCallback(() => {
    const deletableIds = selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    if (deletableIds.length === 0) return
    commands.execute({ type: 'element.delete', elementIds: deletableIds })
    clearSelection()
  }, [clearSelection, commands, selectedElements])

  const {
    alignSelection,
    applyStyle,
    beginErase,
    continueErase,
    duplicateSelection,
    distributeSelection,
    endErase,
    groupSelection,
    insertImage,
    reorderSelection,
    ungroupSelection,
  } = useWhiteboardElementActions({
    clearSelection,
    commands,
    defaultStyle,
    elements,
    replaceSelection,
    selectedElementIds,
    selectedElements,
    setDefaultStyle,
    setHighlightStyle,
    setTool,
    store,
    tool,
    viewport,
  })

  const selectShapeType = useCallback((nextShapeType: WhiteboardShapeType) => {
    setShapeTypeState(nextShapeType)
    setTool('rectangle')
  }, [])

  const {
    copySelection,
    cutSelection,
    pasteClipboardText,
    pasteFromClipboard,
  } = useWhiteboardClipboard({
    clearSelection,
    commands,
    records,
    replaceSelection,
    selectedElements,
  })

  const toggleSelectionLock = useCallback(() => {
    if (selectedElements.length === 0) return
    const shouldLock = !selectedElements.every((element) => element.locked)
    const lockable = getBoardElementsWithDescendants(
      elements,
      selectedElements.map((element) => element.id),
    )
    commands.execute({
      type: 'element.update',
      elements: lockable.map((element) => ({
        ...cloneBoardElement(element),
        locked: shouldLock,
      })),
    })
  }, [commands, elements, selectedElements])

  const nudgeSelection = useCallback((delta: WhiteboardPoint) => {
    const movable = getBoardElementsWithDescendants(
      elements,
      selectedElements.filter((element) => !element.locked).map((element) => element.id),
    )
    if (movable.length === 0) return false
    commands.execute({
      type: 'element.update',
      elements: movable.map((element) => translateWhiteboardElement(element, delta)),
    })
    return true
  }, [commands, elements, selectedElements])

  const selectAll = useCallback(() => {
    replaceSelection(getBoardSelectionRootIds(
      elements,
      elements.map((element) => element.id),
    ))
  }, [elements, replaceSelection])

  const zoomToSelection = useCallback((size: WhiteboardPoint) => {
    if (selectedElements.length === 0) return false
    fitToElements(selectedElements, size)
    return true
  }, [fitToElements, selectedElements])

  const replaceDocument = useCallback((input: {
    records: readonly BoardRecord[]
    viewport: WhiteboardViewport
  }) => {
    cancelInteraction()
    store.replaceRecords(input.records)
    replaceViewport(input.viewport)
    clearSelection()
    dismissEditingText()
    setTool('select')
  }, [cancelInteraction, clearSelection, dismissEditingText, replaceViewport, store])

  useWhiteboardKeyboard({
    deleteSelection,
    duplicateSelection,
    escape: clearTransientState,
    nudgeSelection,
    redo,
    reorderSelection,
    selectAll,
    setTool,
    undo,
  })

  return {
    activeResizeHandle,
    allSelectedLocked: selectedElements.length > 0
      && selectedElements.every((element) => element.locked),
    activeStyle: selectedElements[0]
      ? getWhiteboardElementStyle(selectedElements[0])
      : tool === 'highlight' ? highlightStyle : defaultStyle,
    actualSize,
    alignSelection,
    applyStyle,
    beginCanvasPointer,
    beginErase,
    beginElementPointer,
    beginResizePointer,
    beginRotatePointer,
    beginTextEdit,
    cameraBack,
    cameraForward,
    canRedo: snapshot.canRedo,
    canCameraBack,
    canCameraForward,
    canUndo: snapshot.canUndo,
    cancelInteraction,
    cancelEditingText,
    commitEditingText,
    commands,
    centerViewportAt,
    continueErase,
    copySelection,
    cutSelection,
    deleteSelection,
    duplicateSelection,
    distributeSelection,
    draft,
    editingText,
    elements,
    endErase,
    endPointer,
    exportPng,
    exportSvg,
    fitToContent,
    getViewportElements,
    groupSelection,
    hasSelection: selectedElementIds.length > 0,
    hasUnlockedSelection: selectedElements.some((element) => !element.locked),
    insertImage,
    interactionState: editingText ? 'editing-text' as const : pointerInteractionState,
    isTransacting: snapshot.isTransacting,
    lintFindings,
    movePointer,
    pasteClipboardText,
    pasteFromClipboard,
    records,
    replaceDocument,
    reorderSelection,
    redo,
    selectedElementId,
    selectedElementIds,
    selectedElements,
    selectElement,
    selectAll,
    selectShapeType,
    shapeType,
    snapGuides,
    setTool,
    store,
    toggleSelectionLock,
    tool,
    ungroupSelection,
    undo,
    updateEditingText,
    viewport,
    zoomBy,
    zoomToSelection,
  }
}

export type WhiteboardEditorController = ReturnType<typeof useWhiteboardEditor>
