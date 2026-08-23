import { useCallback, useRef, useState } from 'react'

import type { BoardElementUpdateSession } from '../lib/boardCommands'
import {
  cloneBoardElement,
  type BoardRecord,
} from '../lib/boardRecords'
import type { BoardHistoryMark } from '../lib/boardStore'
import {
  getWhiteboardElementBounds,
  getWhiteboardSelectionBounds,
  normalizeWhiteboardBounds,
  resizeWhiteboardElements,
  rotateWhiteboardElements,
  translateWhiteboardElement,
  whiteboardBoundsIntersect,
} from '../lib/whiteboardGeometry'
import {
  DEFAULT_WHITEBOARD_STYLE,
  getWhiteboardElementStyle,
} from '../lib/whiteboardStyle'
import { createWhiteboardElementId } from '../lib/whiteboardElementId'
import type {
  WhiteboardBounds,
  WhiteboardDraft,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardResizeHandle,
  WhiteboardShapeType,
  WhiteboardTextEditingState,
  WhiteboardTool,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'
import { useBoardEditorStore } from './useBoardEditorStore'
import { useWhiteboardCamera } from './useWhiteboardCamera'
import { useWhiteboardElementActions } from './useWhiteboardElementActions'
import { useWhiteboardKeyboard } from './useWhiteboardKeyboard'
import { useWhiteboardSelection } from './useWhiteboardSelection'

type WhiteboardTransformInteraction = {
  before: WhiteboardElement[]
  session: BoardElementUpdateSession
}

type WhiteboardInteraction =
  | {
      type: 'pan'
      startScreen: WhiteboardPoint
      viewport: WhiteboardViewport
    }
  | (WhiteboardTransformInteraction & {
      type: 'move'
      startWorld: WhiteboardPoint
      duplicateMark?: BoardHistoryMark
      moved: boolean
    })
  | (WhiteboardTransformInteraction & {
      type: 'resize'
      handle: WhiteboardResizeHandle
      selectionBounds: WhiteboardBounds
    })
  | (WhiteboardTransformInteraction & {
      type: 'rotate'
      origin: WhiteboardPoint
      startWorld: WhiteboardPoint
    })
  | {
      type: 'brush'
      additive: boolean
      initialSelection: string[]
      startWorld: WhiteboardPoint
    }
  | {
      type: 'rectangle'
      startWorld: WhiteboardPoint
      shapeStyle?: Extract<WhiteboardElement, { kind: 'rectangle' }>['shapeStyle']
      shapeType: WhiteboardShapeType
      style: WhiteboardElementStyle
      placement: 'shape' | 'note'
    }
  | {
      type: 'connector'
      startWorld: WhiteboardPoint
      style: WhiteboardElementStyle
    }
  | {
      type: 'stroke'
      points: WhiteboardPoint[]
      style: WhiteboardElementStyle
    }

const MIN_DRAW_SIZE = 6
const MIN_BRUSH_SIZE = 3

export function useWhiteboardEditor() {
  const {
    commands,
    elements,
    records,
    snapshot,
    store,
  } = useBoardEditorStore()
  const {
    fitToContent,
    replaceViewport,
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
    toggleSelection,
  } = useWhiteboardSelection(elements)
  const [tool, setTool] = useState<WhiteboardTool>('select')
  const [shapeType, setShapeTypeState] = useState<WhiteboardShapeType>('rectangle')
  const [defaultStyle, setDefaultStyle] = useState<WhiteboardElementStyle>({
    ...DEFAULT_WHITEBOARD_STYLE,
  })
  const [draft, setDraft] = useState<WhiteboardDraft | null>(null)
  const [editingText, setEditingText] = useState<WhiteboardTextEditingState | null>(null)
  const interactionRef = useRef<WhiteboardInteraction | null>(null)

  const cancelInteraction = useCallback(() => {
    const interaction = interactionRef.current
    interactionRef.current = null
    if (
      interaction?.type === 'move'
      || interaction?.type === 'resize'
      || interaction?.type === 'rotate'
    ) {
      interaction.session.cancel()
      if (interaction.type === 'move' && interaction.duplicateMark) {
        store.bailToMark(interaction.duplicateMark)
      }
    }
    setDraft(null)
  }, [store])

  const clearTransientState = useCallback(() => {
    cancelInteraction()
    clearSelection()
    setEditingText(null)
    setTool('select')
  }, [cancelInteraction, clearSelection])

  const undo = useCallback(() => {
    cancelInteraction()
    store.undo()
    clearSelection()
    setEditingText(null)
  }, [cancelInteraction, clearSelection, store])

  const redo = useCallback(() => {
    cancelInteraction()
    store.redo()
    clearSelection()
    setEditingText(null)
  }, [cancelInteraction, clearSelection, store])

  const deleteSelection = useCallback(() => {
    const deletableIds = selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    if (deletableIds.length === 0) return
    commands.execute({ type: 'element.delete', elementIds: deletableIds })
    clearSelection()
  }, [clearSelection, commands, selectedElements])

  const {
    applyStyle,
    beginErase,
    continueErase,
    duplicateSelection,
    endErase,
    insertImage,
  } = useWhiteboardElementActions({
    clearSelection,
    commands,
    defaultStyle,
    elements,
    replaceSelection,
    selectedElementIds,
    selectedElements,
    setDefaultStyle,
    setTool,
    store,
    tool,
    viewport,
  })

  const selectShapeType = useCallback((nextShapeType: WhiteboardShapeType) => {
    setShapeTypeState(nextShapeType)
    setTool('rectangle')
  }, [])

  const beginCanvasPointer = useCallback((input: {
    world: WhiteboardPoint
    screen: WhiteboardPoint
    additive?: boolean
  }) => {
    setEditingText(null)
    switch (tool) {
      case 'select': {
        const additive = Boolean(input.additive)
        interactionRef.current = {
          type: 'brush',
          additive,
          initialSelection: additive ? selectedElementIds : [],
          startWorld: input.world,
        }
        if (!additive) clearSelection()
        setDraft({
          kind: 'selection',
          start: input.world,
          current: input.world,
        })
        break
      }
      case 'hand':
        interactionRef.current = {
          type: 'pan',
          startScreen: input.screen,
          viewport,
        }
        break
      case 'rectangle':
        interactionRef.current = {
          type: 'rectangle',
          placement: 'shape',
          shapeType,
          startWorld: input.world,
          style: { ...defaultStyle },
        }
        setDraft({
          kind: 'rectangle',
          start: input.world,
          current: input.world,
          shapeType,
          style: { ...defaultStyle },
        })
        break
      case 'note': {
        const noteStyle = { ...defaultStyle, fillColor: 'yellow' as const }
        interactionRef.current = {
          type: 'rectangle',
          placement: 'note',
          shapeStyle: 'sticky',
          shapeType: 'rectangle',
          startWorld: input.world,
          style: noteStyle,
        }
        setDraft({
          kind: 'rectangle',
          start: input.world,
          current: input.world,
          shapeStyle: 'sticky',
          shapeType: 'rectangle',
          style: noteStyle,
        })
        break
      }
      case 'connector':
        interactionRef.current = {
          type: 'connector',
          startWorld: input.world,
          style: { ...defaultStyle },
        }
        setDraft({
          kind: 'connector',
          start: input.world,
          current: input.world,
          style: { ...defaultStyle },
        })
        break
      case 'pen':
        interactionRef.current = {
          type: 'stroke',
          points: [input.world],
          style: { ...defaultStyle },
        }
        setDraft({ kind: 'stroke', points: [input.world], style: { ...defaultStyle } })
        break
      case 'text':
        setEditingText({
          elementId: createWhiteboardElementId('text'),
          elementKind: 'text',
          x: input.world.x,
          y: input.world.y,
          value: '',
          isNew: true,
        })
        interactionRef.current = null
        break
      case 'eraser':
        interactionRef.current = null
        break
    }
  }, [clearSelection, defaultStyle, selectedElementIds, shapeType, tool, viewport])

  const beginElementPointer = useCallback((
    elementId: string,
    world: WhiteboardPoint,
    options: { additive?: boolean; duplicate?: boolean } = {},
  ) => {
    if (tool !== 'select') return false
    const element = elements.find((item) => item.id === elementId)
    if (!element) return false
    cancelInteraction()

    if (options.additive && selectedElementIds.includes(elementId)) {
      toggleSelection(elementId)
      return false
    }

    const nextSelection = options.additive
      ? [...selectedElementIds, elementId]
      : selectedElementIds.includes(elementId)
        ? selectedElementIds
        : [elementId]
    replaceSelection(nextSelection)

    const editableElements = elements.filter((item) => (
      nextSelection.includes(item.id) && !item.locked
    ))
    if (editableElements.length === 0) return false

    let before = editableElements.map(cloneBoardElement)
    let duplicateMark: BoardHistoryMark | undefined
    if (options.duplicate) {
      duplicateMark = store.markHistory()
      before = editableElements.map((item) => ({
        ...cloneBoardElement(item),
        id: createWhiteboardElementId(item.kind),
        locked: false,
      }))
      commands.execute({ type: 'element.create', elements: before })
      replaceSelection(before.map((item) => item.id))
    }

    interactionRef.current = {
      type: 'move',
      before,
      duplicateMark,
      moved: false,
      session: commands.beginElementUpdate('Move elements'),
      startWorld: world,
    }
    return true
  }, [
    cancelInteraction,
    commands,
    elements,
    replaceSelection,
    selectedElementIds,
    store,
    toggleSelection,
    tool,
  ])

  const selectElement = useCallback((
    elementId: string,
    options: { additive?: boolean } = {},
  ) => {
    if (tool !== 'select') return false
    const element = elements.find((item) => item.id === elementId)
    if (!element) return false
    cancelInteraction()

    if (options.additive && selectedElementIds.includes(elementId)) {
      toggleSelection(elementId)
      return false
    }

    replaceSelection(options.additive
      ? [...selectedElementIds, elementId]
      : [elementId])
    return true
  }, [
    cancelInteraction,
    elements,
    replaceSelection,
    selectedElementIds,
    toggleSelection,
    tool,
  ])

  const beginResizePointer = useCallback((
    handle: WhiteboardResizeHandle,
  ) => {
    const editableElements = selectedElements.filter((element) => !element.locked)
    const selectionBounds = getWhiteboardSelectionBounds(editableElements)
    if (!selectionBounds || editableElements.length === 0) return false
    cancelInteraction()
    interactionRef.current = {
      type: 'resize',
      before: editableElements.map(cloneBoardElement),
      handle,
      selectionBounds,
      session: commands.beginElementUpdate('Resize elements'),
    }
    return true
  }, [cancelInteraction, commands, selectedElements])

  const beginRotatePointer = useCallback((world: WhiteboardPoint) => {
    const editableElements = selectedElements.filter((element) => !element.locked)
    const selectionBounds = getWhiteboardSelectionBounds(editableElements)
    if (!selectionBounds || editableElements.length === 0) return false
    cancelInteraction()
    interactionRef.current = {
      type: 'rotate',
      before: editableElements.map(cloneBoardElement),
      origin: {
        x: selectionBounds.x + selectionBounds.width / 2,
        y: selectionBounds.y + selectionBounds.height / 2,
      },
      session: commands.beginElementUpdate('Rotate elements'),
      startWorld: world,
    }
    return true
  }, [cancelInteraction, commands, selectedElements])

  const movePointer = useCallback((input: {
    world: WhiteboardPoint
    screen: WhiteboardPoint
    altKey?: boolean
    shiftKey?: boolean
  }) => {
    const interaction = interactionRef.current
    if (!interaction) return
    switch (interaction.type) {
      case 'pan': {
        const delta = {
          x: input.screen.x - interaction.startScreen.x,
          y: input.screen.y - interaction.startScreen.y,
        }
        setViewport({
          ...interaction.viewport,
          x: interaction.viewport.x - delta.x / interaction.viewport.zoom,
          y: interaction.viewport.y - delta.y / interaction.viewport.zoom,
        })
        break
      }
      case 'move': {
        const delta = {
          x: input.world.x - interaction.startWorld.x,
          y: input.world.y - interaction.startWorld.y,
        }
        interaction.moved = interaction.moved
          || Math.abs(delta.x) > 0.5
          || Math.abs(delta.y) > 0.5
        interaction.session.update(interaction.before.map((element) => (
          translateWhiteboardElement(element, delta)
        )))
        break
      }
      case 'resize':
        interaction.session.update(resizeWhiteboardElements({
          elements: interaction.before,
          fromCenter: input.altKey,
          handle: interaction.handle,
          lockAspectRatio: input.shiftKey,
          point: input.world,
          selectionBounds: interaction.selectionBounds,
        }))
        break
      case 'rotate':
        interaction.session.update(rotateWhiteboardElements({
          elements: interaction.before,
          origin: interaction.origin,
          point: input.world,
          snap: input.shiftKey,
          start: interaction.startWorld,
        }))
        break
      case 'brush':
        setDraft({
          kind: 'selection',
          start: interaction.startWorld,
          current: input.world,
        })
        break
      case 'rectangle':
        setDraft({
          kind: 'rectangle',
          start: interaction.startWorld,
          current: input.world,
          shapeStyle: interaction.shapeStyle,
          shapeType: interaction.shapeType,
          style: interaction.style,
        })
        break
      case 'connector':
        setDraft({
          kind: 'connector',
          start: interaction.startWorld,
          current: input.world,
          style: interaction.style,
        })
        break
      case 'stroke': {
        const previous = interaction.points.at(-1)
        if (!previous || Math.hypot(
          input.world.x - previous.x,
          input.world.y - previous.y,
        ) >= 1.5 / viewport.zoom) {
          interaction.points.push(input.world)
          setDraft({
            kind: 'stroke',
            points: [...interaction.points],
            style: interaction.style,
          })
        }
        break
      }
    }
  }, [setViewport, viewport.zoom])

  const endPointer = useCallback((world: WhiteboardPoint) => {
    const interaction = interactionRef.current
    interactionRef.current = null
    setDraft(null)
    if (!interaction) return

    switch (interaction.type) {
      case 'move':
        if (interaction.moved) interaction.session.commit()
        else interaction.session.cancel()
        if (interaction.duplicateMark) {
          store.squashToMark(interaction.duplicateMark, 'Duplicate elements')
        }
        break
      case 'resize':
      case 'rotate':
        interaction.session.commit()
        break
      case 'brush': {
        const bounds = normalizeWhiteboardBounds(interaction.startWorld, world)
        if (bounds.width < MIN_BRUSH_SIZE && bounds.height < MIN_BRUSH_SIZE) break
        const selected = elements
          .filter((element) => whiteboardBoundsIntersect(
            bounds,
            getWhiteboardElementBounds(element),
          ))
          .map((element) => element.id)
        setSelectedElementIds([
          ...new Set([...interaction.initialSelection, ...selected]),
        ])
        break
      }
      case 'rectangle': {
        let bounds = normalizeWhiteboardBounds(interaction.startWorld, world)
        if (bounds.width < MIN_DRAW_SIZE || bounds.height < MIN_DRAW_SIZE) {
          const defaultSize = interaction.placement === 'note'
            ? { width: 180, height: 140 }
            : { width: 160, height: interaction.shapeType === 'line' ? 32 : 100 }
          bounds = {
            x: interaction.startWorld.x,
            y: interaction.startWorld.y,
            ...defaultSize,
          }
        }
        if (bounds.width >= MIN_DRAW_SIZE && bounds.height >= MIN_DRAW_SIZE) {
          const element: WhiteboardElement = {
            id: createWhiteboardElementId('rectangle'),
            kind: 'rectangle',
            locked: false,
            rotation: 0,
            shapeStyle: interaction.shapeStyle,
            shapeType: interaction.shapeType,
            style: interaction.style,
            ...bounds,
          }
          commands.execute({ type: 'element.create', elements: [element] })
          replaceSelection([element.id])
          if (interaction.placement === 'note') {
            setEditingText({
              elementId: element.id,
              elementKind: 'rectangle',
              x: element.x + 12,
              y: element.y + element.height / 2,
              value: '',
              isNew: false,
            })
          }
        }
        setTool('select')
        break
      }
      case 'connector':
        if (Math.hypot(
          world.x - interaction.startWorld.x,
          world.y - interaction.startWorld.y,
        ) >= MIN_DRAW_SIZE) {
          const element: WhiteboardElement = {
            id: createWhiteboardElementId('connector'),
            kind: 'connector',
            locked: false,
            rotation: 0,
            start: interaction.startWorld,
            end: world,
            style: interaction.style,
          }
          commands.execute({ type: 'element.create', elements: [element] })
          replaceSelection([element.id])
        }
        setTool('select')
        break
      case 'stroke':
        if (interaction.points.length > 1) {
          const element: WhiteboardElement = {
            id: createWhiteboardElementId('stroke'),
            kind: 'stroke',
            locked: false,
            rotation: 0,
            points: interaction.points,
            style: interaction.style,
          }
          commands.execute({ type: 'element.create', elements: [element] })
          replaceSelection([element.id])
        }
        break
      case 'pan':
        break
    }
  }, [commands, elements, replaceSelection, setSelectedElementIds, store])

  const beginTextEdit = useCallback((element: WhiteboardElement) => {
    if ((element.kind !== 'text' && element.kind !== 'rectangle') || element.locked) return
    cancelInteraction()
    replaceSelection([element.id])
    setEditingText({
      elementId: element.id,
      elementKind: element.kind,
      x: element.kind === 'rectangle' ? element.x + 12 : element.x,
      y: element.kind === 'rectangle' ? element.y + element.height / 2 : element.y,
      value: element.text || '',
      isNew: false,
    })
  }, [cancelInteraction, replaceSelection])

  const updateEditingText = useCallback((value: string) => {
    setEditingText((current) => current ? { ...current, value } : current)
  }, [])

  const commitEditingText = useCallback(() => {
    if (!editingText) return
    const value = editingText.value.trim()
    if (value) {
      const current = elements.find((element) => element.id === editingText.elementId)
      const element: WhiteboardElement = current?.kind === 'rectangle'
        ? { ...current, text: value }
        : {
            ...(current?.kind === 'text' ? current : {}),
            id: editingText.elementId,
            kind: 'text',
            x: editingText.x,
            y: editingText.y,
            text: value,
            fontSize: current?.kind === 'text' ? current.fontSize ?? 22 : 22,
            locked: current?.locked ?? false,
            rotation: current?.rotation ?? 0,
            style: current?.kind === 'text' && current.style
              ? { ...current.style }
              : { ...defaultStyle },
          }
      commands.execute({
        type: editingText.isNew ? 'element.create' : 'element.update',
        elements: [element],
      })
      replaceSelection([element.id])
    }
    setEditingText(null)
    setTool('select')
  }, [commands, defaultStyle, editingText, elements, replaceSelection])

  const cancelEditingText = useCallback(() => {
    setEditingText(null)
    setTool('select')
  }, [])

  const toggleSelectionLock = useCallback(() => {
    if (selectedElements.length === 0) return
    const shouldLock = !selectedElements.every((element) => element.locked)
    commands.execute({
      type: 'element.update',
      elements: selectedElements.map((element) => ({
        ...cloneBoardElement(element),
        locked: shouldLock,
      })),
    })
  }, [commands, selectedElements])

  const nudgeSelection = useCallback((delta: WhiteboardPoint) => {
    const movable = selectedElements.filter((element) => !element.locked)
    if (movable.length === 0) return false
    commands.execute({
      type: 'element.update',
      elements: movable.map((element) => translateWhiteboardElement(element, delta)),
    })
    return true
  }, [commands, selectedElements])

  const selectAll = useCallback(() => {
    replaceSelection(elements.map((element) => element.id))
  }, [elements, replaceSelection])

  const replaceDocument = useCallback((input: {
    records: readonly BoardRecord[]
    viewport: WhiteboardViewport
  }) => {
    cancelInteraction()
    store.replaceRecords(input.records)
    replaceViewport(input.viewport)
    clearSelection()
    setDraft(null)
    setEditingText(null)
    setTool('select')
  }, [cancelInteraction, clearSelection, replaceViewport, store])

  useWhiteboardKeyboard({
    deleteSelection,
    duplicateSelection,
    escape: clearTransientState,
    nudgeSelection,
    redo,
    selectAll,
    setTool,
    undo,
  })

  return {
    allSelectedLocked: selectedElements.length > 0
      && selectedElements.every((element) => element.locked),
    activeStyle: selectedElements[0]
      ? getWhiteboardElementStyle(selectedElements[0])
      : defaultStyle,
    applyStyle,
    beginCanvasPointer,
    beginErase,
    beginElementPointer,
    beginResizePointer,
    beginRotatePointer,
    beginTextEdit,
    canRedo: snapshot.canRedo,
    canUndo: snapshot.canUndo,
    cancelInteraction,
    cancelEditingText,
    commitEditingText,
    commands,
    continueErase,
    deleteSelection,
    duplicateSelection,
    draft,
    editingText,
    elements,
    endErase,
    endPointer,
    fitToContent,
    hasSelection: selectedElementIds.length > 0,
    hasUnlockedSelection: selectedElements.some((element) => !element.locked),
    insertImage,
    isTransacting: snapshot.isTransacting,
    movePointer,
    records,
    replaceDocument,
    redo,
    selectedElementId,
    selectedElementIds,
    selectedElements,
    selectElement,
    selectAll,
    selectShapeType,
    shapeType,
    setTool,
    store,
    toggleSelectionLock,
    tool,
    undo,
    updateEditingText,
    viewport,
    zoomBy,
  }
}

export type WhiteboardEditorController = ReturnType<typeof useWhiteboardEditor>
