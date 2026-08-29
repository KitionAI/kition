import { useCallback, useMemo, useRef, useState } from 'react'

import {
  cloneBoardElement,
  type BoardBindingRecord,
  type BoardRecord,
} from '../lib/boardRecords'
import type { BoardHistoryMark } from '../lib/boardStore'
import {
  getBoardElementsWithDescendants,
  getBoardFrameAtPoint,
  getBoardSelectionRootIds,
} from '../lib/boardHierarchy'
import { translateWhiteboardElement } from '../lib/whiteboardGeometry'
import { lintWhiteboard } from '../lib/whiteboardLint'
import { getWhiteboardMindMapPresentation } from '../lib/whiteboardMindMap'
import {
  instantiateWhiteboardTemplate,
  type WhiteboardTemplateId,
} from '../lib/whiteboardTemplates'
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
import { useWhiteboardMindMapActions } from './useWhiteboardMindMapActions'
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
  const boardBindings = useMemo(() => records.filter((record): record is BoardBindingRecord => (
    record.record_type === 'binding'
  )), [records])
  const mindMapPresentation = useMemo(() => getWhiteboardMindMapPresentation({
    bindings: boardBindings,
    elements,
  }), [boardBindings, elements])
  const visibleElements = useMemo(() => elements.filter((element) => (
    !mindMapPresentation.hiddenElementIds.has(element.id)
  )), [elements, mindMapPresentation.hiddenElementIds])
  const {
    actualSize,
    cameraBack,
    cameraForward,
    canCameraBack,
    canCameraForward,
    centerViewportAt,
    fitToContent,
    fitToElements,
    panBy,
    replaceViewport,
    recordViewportHistory,
    setViewport,
    viewport,
    zoomBy,
  } = useWhiteboardCamera(visibleElements)
  const {
    clearSelection,
    replaceSelection,
    selectedElementId,
    selectedElementIds,
    selectedElements,
    setSelectedElementIds,
  } = useWhiteboardSelection(elements)
  const [tool, setTool] = useState<WhiteboardTool>('select')
  const [gridVisible, setGridVisible] = useState(true)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [toolLocked, setToolLocked] = useState(false)
  const [shapeType, setShapeTypeState] = useState<WhiteboardShapeType>('rectangle')
  const [defaultStyle, setDefaultStyle] = useState<WhiteboardElementStyle>({
    ...DEFAULT_WHITEBOARD_STYLE,
  })
  const [highlightStyle, setHighlightStyle] = useState<WhiteboardElementStyle>({
    ...DEFAULT_WHITEBOARD_HIGHLIGHT_STYLE,
  })
  const { exportPng, exportSvg } = useWhiteboardExport(visibleElements)
  const lintFindings = useMemo(() => lintWhiteboard({
    bindings: boardBindings,
    elements,
  }), [boardBindings, elements])
  const queryElements = useCallback((bounds: WhiteboardBounds) => (
    store.queryCurrentPageElements(bounds).filter((element) => (
      !mindMapPresentation.hiddenElementIds.has(element.id)
    ))
  ), [mindMapPresentation.hiddenElementIds, store])
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
    beginConnectionHandlePointer,
    beginConnectorTerminalPointer,
    beginElementPointer,
    beginResizePointer,
    beginRotatePointer,
    cancelInteraction,
    connectorTerminalPreview,
    connectorTargetElementId,
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
    snapEnabled,
    shapeType,
    store,
    tool,
    toolLocked,
    viewport,
  })

  const pendingMindMapInsertRef = useRef<{
    elementId: string
    historyMark: BoardHistoryMark
  } | null>(null)
  const handleEditingTextFinished = useCallback((result: {
    committed: boolean
    elementId: string
  }) => {
    const pending = pendingMindMapInsertRef.current
    if (!pending || pending.elementId !== result.elementId) return
    pendingMindMapInsertRef.current = null
    if (result.committed) {
      store.squashToMark(pending.historyMark, 'Add mind map node')
    } else {
      store.bailToMark(pending.historyMark)
      clearSelection()
    }
  }, [clearSelection, store])

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
    onEditingTextFinished: handleEditingTextFinished,
    replaceSelection,
    setTool,
  })

  const beginInsertedNodeTextEdit = useCallback((
    element: Parameters<typeof beginTextEdit>[0],
    historyMark: BoardHistoryMark,
  ) => {
    pendingMindMapInsertRef.current = { elementId: element.id, historyMark }
    beginTextEdit(element)
  }, [beginTextEdit])

  const mindMapActions = useWhiteboardMindMapActions({
    beginInsertedNodeTextEdit,
    commands,
    elements,
    records,
    replaceSelection,
    selectedElements,
    store,
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

  const beginCanvasTextEdit = useCallback((point: WhiteboardPoint) => {
    cancelInteraction()
    dismissEditingText()
    clearSelection()
    beginNewTextEdit(point, getBoardFrameAtPoint(elements, point)?.id)
  }, [beginNewTextEdit, cancelInteraction, clearSelection, dismissEditingText, elements])

  const editSelection = useCallback(() => {
    if (selectedElements.length !== 1) return false
    const element = selectedElements[0]
    if (element.locked || (element.kind !== 'rectangle' && element.kind !== 'text')) return false
    beginTextEdit(element)
    return true
  }, [beginTextEdit, selectedElements])

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
    activatePage,
    alignSelection,
    applyStyle,
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
    groupSelection,
    insertImage,
    renamePage,
    reorderPage,
    reorderSelection,
    rotateSelection,
    stackSelection,
    ungroupSelection,
    updateSelectedConnectors,
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
      visibleElements,
      visibleElements.map((element) => element.id),
    ))
  }, [replaceSelection, visibleElements])

  const zoomToSelection = useCallback((size: WhiteboardPoint) => {
    if (selectedElements.length === 0) return false
    fitToElements(selectedElements, size)
    return true
  }, [fitToElements, selectedElements])

  const insertTemplate = useCallback((
    templateId: WhiteboardTemplateId,
    canvasSize: WhiteboardPoint,
    resolveText: (key: string) => string,
  ) => {
    cancelInteraction()
    dismissEditingText()
    const instance = instantiateWhiteboardTemplate(templateId, {
      x: viewport.x + canvasSize.x / viewport.zoom / 2,
      y: viewport.y + canvasSize.y / viewport.zoom / 2,
    }, resolveText)
    commands.execute({
      type: 'element.paste',
      bindings: instance.bindings,
      elements: instance.elements,
    })
    replaceSelection(instance.rootIds)
    setTool('select')
    return instance.rootIds
  }, [
    cancelInteraction,
    commands,
    dismissEditingText,
    replaceSelection,
    viewport,
  ])

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

  const addMindMapChildFromKeyboard = useCallback(() => (
    Boolean(mindMapActions.addMindMapChild(''))
  ), [mindMapActions.addMindMapChild])
  const addMindMapSiblingFromKeyboard = useCallback(() => (
    Boolean(mindMapActions.addMindMapSibling(''))
  ), [mindMapActions.addMindMapSibling])

  useWhiteboardKeyboard({
    addMindMapChild: addMindMapChildFromKeyboard,
    addMindMapSibling: addMindMapSiblingFromKeyboard,
    deleteSelection,
    duplicateSelection,
    editSelection,
    escape: clearTransientState,
    nudgeSelection,
    redo,
    reorderSelection,
    selectAll,
    setTool,
    tool,
    undo,
  })

  return {
    activeResizeHandle,
    activatePage,
    addMindMapChild: mindMapActions.addMindMapChild,
    addMindMapChildAt: mindMapActions.addMindMapChildAt,
    addMindMapSibling: mindMapActions.addMindMapSibling,
    allSelectedLocked: selectedElements.length > 0
      && selectedElements.every((element) => element.locked),
    activeStyle: selectedElements[0]
      ? getWhiteboardElementStyle(selectedElements[0])
      : tool === 'highlight' ? highlightStyle : defaultStyle,
    actualSize,
    alignSelection,
    applyStyle,
    beginCanvasPointer,
    beginCanvasTextEdit,
    beginConnectionHandlePointer,
    beginConnectorTerminalPointer,
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
    canAddMindMapSibling: mindMapActions.canAddMindMapSibling,
    canEditMindMap: mindMapActions.canEditMindMap,
    cancelInteraction,
    cancelEditingText,
    clearSelection,
    commitEditingText,
    connectorTerminalPreview,
    connectorTargetElementId,
    commands,
    centerViewportAt,
    continueErase,
    copySelection,
    createPage,
    currentPageId: store.getCurrentPageId(),
    cutSelection,
    deletePage,
    deleteSelection,
    duplicatePage,
    duplicateSelection,
    distributeSelection,
    draft,
    editingText,
    elements,
    endErase,
    endPointer,
    exportPng,
    exportSvg,
    fitFramesToContent,
    fitToContent,
    flipSelection,
    getViewportElements,
    gridVisible,
    groupSelection,
    hasSelection: selectedElementIds.length > 0,
    hasUnlockedSelection: selectedElements.some((element) => !element.locked),
    insertImage,
    insertTemplate,
    interactionState: editingText ? 'editing-text' as const : pointerInteractionState,
    isTransacting: snapshot.isTransacting,
    lintFindings,
    mindMapDirection: mindMapActions.mindMapDirection,
    mindMapHiddenElementIds: mindMapPresentation.hiddenElementIds,
    mindMapManagedConnectorIds: mindMapPresentation.managedConnectorIds,
    mindMapRootNode: mindMapActions.mindMapRootNode,
    movePointer,
    panBy,
    pages: store.getPages(),
    pasteClipboardText,
    pasteFromClipboard,
    records,
    renamePage,
    replaceDocument,
    reorderPage,
    reorderSelection,
    redo,
    selectedElementId,
    selectedElementIds,
    selectedElements,
    selectedMindMapNode: mindMapActions.selectedMindMapNode,
    selectElement,
    selectAll,
    selectShapeType,
    shapeType,
    snapGuides,
    snapEnabled,
    setTool,
    setMindMapDirection: mindMapActions.setMindMapDirection,
    store,
    stackSelection,
    toggleSelectionLock,
    tool,
    toolLocked,
    toggleGrid: () => setGridVisible((visible) => !visible),
    toggleMindMapCollapsed: mindMapActions.toggleMindMapCollapsed,
    toggleSnap: () => setSnapEnabled((enabled) => !enabled),
    toggleToolLock: () => setToolLocked((locked) => !locked),
    ungroupSelection,
    undo,
    updateEditingText,
    updateSelectedConnectors,
    viewport,
    rotateSelection,
    zoomBy,
    zoomToSelection,
  }
}

export type WhiteboardEditorController = ReturnType<typeof useWhiteboardEditor>
