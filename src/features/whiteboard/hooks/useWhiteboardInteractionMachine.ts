import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import { getBoardConnectorAnchor } from '../lib/boardBindingEngine'
import { getBoardRectangleDefaultSize } from '../lib/boardElementDefinitions'
import {
  BoardInteractionMachine,
  isBoardTransformInteraction,
  type BoardActiveInteractionState,
  type BoardInteractionState,
} from '../lib/boardInteractionMachine'
import { cloneBoardElement } from '../lib/boardRecords'
import {
  cloneBoardElementTrees,
  getBoardElementsWithDescendants,
  getBoardFrameAtPoint,
  getBoardSelectionRootIds,
  isBoardFrameElement,
  resolveBoardSelectableElementId,
} from '../lib/boardHierarchy'
import type { BoardStore } from '../lib/boardStore'
import { createWhiteboardElementId } from '../lib/whiteboardElementId'
import { simplifyBoardFreehandPoints } from '../lib/boardFreehand'
import {
  getBoardResizeSnap,
  getBoardTranslationSnap,
  type BoardSnapGuide,
} from '../lib/boardSnapManager'
import {
  getWhiteboardElementBounds,
  getWhiteboardElementCenter,
  getWhiteboardSelectionBounds,
  normalizeWhiteboardBounds,
  resizeWhiteboardElements,
  rotateWhiteboardElements,
  translateWhiteboardElement,
  whiteboardBoundsIntersect,
} from '../lib/whiteboardGeometry'
import type {
  WhiteboardBounds,
  WhiteboardDraft,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardResizeHandle,
  WhiteboardShapeType,
  WhiteboardTool,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'

const MIN_DRAW_SIZE = 6
const MIN_BRUSH_SIZE = 3

type PointerInput = {
  world: WhiteboardPoint
  screen: WhiteboardPoint
  altKey?: boolean
  shiftKey?: boolean
}

type PointerEndResult = {
  editElement?: WhiteboardElement
}

export function useWhiteboardInteractionMachine(input: {
  clearSelection: () => void
  commands: BoardCommandRegistry
  defaultStyle: WhiteboardElementStyle
  elements: readonly WhiteboardElement[]
  highlightStyle: WhiteboardElementStyle
  queryElements: (bounds: WhiteboardBounds) => readonly WhiteboardElement[]
  replaceSelection: (ids: readonly string[]) => void
  recordViewportHistory: (previous: WhiteboardViewport) => void
  selectedElementIds: string[]
  selectedElements: readonly WhiteboardElement[]
  setSelectedElementIds: Dispatch<SetStateAction<string[]>>
  setTool: Dispatch<SetStateAction<WhiteboardTool>>
  setViewport: Dispatch<SetStateAction<WhiteboardViewport>>
  shapeType: WhiteboardShapeType
  store: BoardStore
  tool: WhiteboardTool
  viewport: WhiteboardViewport
}) {
  const machineRef = useRef<BoardInteractionMachine | null>(null)
  if (!machineRef.current) machineRef.current = new BoardInteractionMachine()
  const machine = machineRef.current
  const [draft, setDraft] = useState<WhiteboardDraft | null>(null)
  const [interactionState, setInteractionState] = useState<BoardInteractionState['type']>('idle')
  const [snapGuides, setSnapGuides] = useState<BoardSnapGuide[]>([])

  const enterInteraction = useCallback((interaction: BoardActiveInteractionState) => {
    machine.start(interaction)
    setInteractionState(interaction.type)
  }, [machine])

  const cancelInteraction = useCallback(() => {
    const interaction = machine.reset()
    cancelBoardInteraction(interaction, input.store)
    if (interaction.type === 'panning') input.setViewport(interaction.viewport)
    setDraft(null)
    setSnapGuides([])
    setInteractionState('idle')
  }, [input.store, machine])

  useEffect(() => () => {
    cancelBoardInteraction(machine.reset(), input.store)
  }, [input.store, machine])

  const beginCanvasPointer = useCallback((pointer: {
    world: WhiteboardPoint
    screen: WhiteboardPoint
    additive?: boolean
    targetElementId?: string
  }) => {
    cancelInteraction()
    switch (input.tool) {
      case 'select': {
        const additive = Boolean(pointer.additive)
        enterInteraction({
          type: 'brushing',
          additive,
          initialSelection: additive ? input.selectedElementIds : [],
          startWorld: pointer.world,
        })
        if (!additive) input.clearSelection()
        setDraft({
          kind: 'selection',
          start: pointer.world,
          current: pointer.world,
        })
        return true
      }
      case 'hand':
        enterInteraction({
          type: 'panning',
          startScreen: pointer.screen,
          viewport: input.viewport,
        })
        return true
      case 'rectangle':
        enterInteraction({
          type: 'drawing-shape',
          placement: 'shape',
          shapeType: input.shapeType,
          startWorld: pointer.world,
          style: { ...input.defaultStyle },
        })
        setDraft({
          kind: 'rectangle',
          start: pointer.world,
          current: pointer.world,
          shapeType: input.shapeType,
          style: { ...input.defaultStyle },
        })
        return true
      case 'note': {
        const noteStyle = { ...input.defaultStyle, fillColor: 'yellow' as const }
        enterInteraction({
          type: 'drawing-shape',
          placement: 'note',
          shapeStyle: 'sticky',
          shapeType: 'rectangle',
          startWorld: pointer.world,
          style: noteStyle,
        })
        setDraft({
          kind: 'rectangle',
          start: pointer.world,
          current: pointer.world,
          shapeStyle: 'sticky',
          shapeType: 'rectangle',
          style: noteStyle,
        })
        return true
      }
      case 'connector': {
        const startBinding = getBoardConnectorAnchor(
          input.elements.find((element) => element.id === pointer.targetElementId),
          pointer.world,
        ) || undefined
        const startWorld = startBinding?.point || pointer.world
        enterInteraction({
          type: 'connecting',
          startBinding,
          startWorld,
          style: { ...input.defaultStyle },
        })
        setDraft({
          kind: 'connector',
          start: startWorld,
          current: startWorld,
          style: { ...input.defaultStyle },
        })
        return true
      }
      case 'pen':
        enterInteraction({
          type: 'drawing-stroke',
          points: [pointer.world],
          style: { ...input.defaultStyle },
          tool: 'pen',
        })
        setDraft({
          kind: 'stroke',
          points: [pointer.world],
          style: { ...input.defaultStyle },
        })
        return true
      case 'highlight': {
        const highlightStyle = { ...input.highlightStyle }
        enterInteraction({
          type: 'drawing-stroke',
          points: [pointer.world],
          style: highlightStyle,
          tool: 'highlight',
        })
        setDraft({ kind: 'stroke', points: [pointer.world], style: highlightStyle })
        return true
      }
      case 'eraser':
      case 'text':
        return false
    }
  }, [cancelInteraction, enterInteraction, input])

  const beginElementPointer = useCallback((
    elementId: string,
    world: WhiteboardPoint,
    options: { additive?: boolean; duplicate?: boolean } = {},
  ) => {
    if (input.tool !== 'select') return false
    const targetElementId = input.selectedElementIds.includes(elementId)
      ? elementId
      : resolveBoardSelectableElementId(input.elements, elementId)
    const element = input.elements.find((item) => item.id === targetElementId)
    if (!element) return false
    cancelInteraction()

    if (options.additive && input.selectedElementIds.includes(targetElementId)) {
      input.setSelectedElementIds((current) => current.filter((id) => id !== targetElementId))
      return false
    }

    const nextSelection = options.additive
      ? [...input.selectedElementIds, targetElementId]
      : input.selectedElementIds.includes(targetElementId)
        ? input.selectedElementIds
        : [targetElementId]
    const rootIds = getBoardSelectionRootIds(input.elements, nextSelection)
    input.replaceSelection(rootIds)

    const editableRootIds = rootIds.filter((id) => (
      !input.elements.find((item) => item.id === id)?.locked
    ))
    const editableElements = getBoardElementsWithDescendants(
      input.elements,
      editableRootIds,
    )
    if (editableElements.length === 0) return false

    let before = editableElements.map(cloneBoardElement)
    let interactionRootIds = editableRootIds
    let duplicateMark
    if (options.duplicate) {
      duplicateMark = input.store.markHistory()
      const cloned = cloneBoardElementTrees(input.elements, editableRootIds)
      before = cloned.elements
      interactionRootIds = cloned.rootIds
      input.commands.execute({ type: 'element.create', elements: before })
      input.replaceSelection(interactionRootIds)
    }

    enterInteraction({
      type: 'translating',
      before,
      current: before,
      duplicateMark,
      moved: false,
      rootIds: interactionRootIds,
      session: input.commands.beginElementUpdate('Move elements'),
      startWorld: world,
    })
    return true
  }, [cancelInteraction, enterInteraction, input])

  const selectElement = useCallback((
    elementId: string,
    options: { additive?: boolean } = {},
  ) => {
    if (input.tool !== 'select') return false
    const targetElementId = resolveBoardSelectableElementId(input.elements, elementId)
    const element = input.elements.find((item) => item.id === targetElementId)
    if (!element) return false
    cancelInteraction()

    if (options.additive && input.selectedElementIds.includes(targetElementId)) {
      input.setSelectedElementIds((current) => current.filter((id) => id !== targetElementId))
      return false
    }

    input.replaceSelection(getBoardSelectionRootIds(
      input.elements,
      options.additive
        ? [...input.selectedElementIds, targetElementId]
        : [targetElementId],
    ))
    return true
  }, [cancelInteraction, input])

  const beginResizePointer = useCallback((handle: WhiteboardResizeHandle) => {
    const editableRootIds = input.selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    const editableElements = getBoardElementsWithDescendants(
      input.elements,
      editableRootIds,
    )
    const selectionBounds = getWhiteboardSelectionBounds(editableElements)
    if (!selectionBounds || editableElements.length === 0) return false
    cancelInteraction()
    enterInteraction({
      type: 'resizing',
      before: editableElements.map(cloneBoardElement),
      handle,
      selectionBounds,
      session: input.commands.beginElementUpdate('Resize elements'),
    })
    return true
  }, [cancelInteraction, enterInteraction, input.commands, input.elements, input.selectedElements])

  const beginRotatePointer = useCallback((world: WhiteboardPoint) => {
    const editableRootIds = input.selectedElements
      .filter((element) => !element.locked)
      .map((element) => element.id)
    const editableElements = getBoardElementsWithDescendants(
      input.elements,
      editableRootIds,
    )
    const selectionBounds = getWhiteboardSelectionBounds(editableElements)
    if (!selectionBounds || editableElements.length === 0) return false
    cancelInteraction()
    enterInteraction({
      type: 'rotating',
      before: editableElements.map(cloneBoardElement),
      origin: {
        x: selectionBounds.x + selectionBounds.width / 2,
        y: selectionBounds.y + selectionBounds.height / 2,
      },
      session: input.commands.beginElementUpdate('Rotate elements'),
      startWorld: world,
    })
    return true
  }, [cancelInteraction, enterInteraction, input.commands, input.elements, input.selectedElements])

  const movePointer = useCallback((pointer: PointerInput) => {
    const interaction = machine.getState()
    switch (interaction.type) {
      case 'idle':
        break
      case 'panning': {
        const delta = {
          x: pointer.screen.x - interaction.startScreen.x,
          y: pointer.screen.y - interaction.startScreen.y,
        }
        input.setViewport({
          ...interaction.viewport,
          x: interaction.viewport.x - delta.x / interaction.viewport.zoom,
          y: interaction.viewport.y - delta.y / interaction.viewport.zoom,
        })
        break
      }
      case 'translating': {
        const delta = {
          x: pointer.world.x - interaction.startWorld.x,
          y: pointer.world.y - interaction.startWorld.y,
        }
        interaction.moved = interaction.moved
          || Math.abs(delta.x) > 0.5
          || Math.abs(delta.y) > 0.5
        const proposed = interaction.before.map((element) => (
          translateWhiteboardElement(element, delta)
        ))
        const movingIds = new Set(interaction.before.map((element) => element.id))
        const proposedBounds = getWhiteboardSelectionBounds(proposed)
        const snapSearchMargin = Math.max(128, 512 / input.viewport.zoom)
        const snapCandidates = proposedBounds
          ? input.queryElements(expandWhiteboardBounds(proposedBounds, snapSearchMargin))
          : input.elements
        const snap = pointer.altKey
          ? { adjustment: { x: 0, y: 0 }, guides: [] }
          : getBoardTranslationSnap({
              movingElements: proposed,
              stationaryElements: snapCandidates.filter((element) => (
                !movingIds.has(element.id)
                && element.kind !== 'connector'
                && element.kind !== 'stroke'
              )),
              threshold: 6 / input.viewport.zoom,
            })
        const snappedDelta = {
          x: delta.x + snap.adjustment.x,
          y: delta.y + snap.adjustment.y,
        }
        interaction.current = interaction.before.map((element) => (
          translateWhiteboardElement(element, snappedDelta)
        ))
        interaction.session.update(interaction.current)
        setSnapGuides(snap.guides)
        break
      }
      case 'resizing': {
        const movingIds = new Set(interaction.before.map((element) => element.id))
        const resizeSearchBounds = expandWhiteboardBounds(
          normalizeWhiteboardBounds({
            x: interaction.selectionBounds.x,
            y: interaction.selectionBounds.y,
          }, pointer.world),
          Math.max(128, 512 / input.viewport.zoom),
        )
        const resizeSnap = getBoardResizeSnap({
          handle: interaction.handle,
          point: pointer.world,
          selectionBounds: interaction.selectionBounds,
          stationaryElements: input.queryElements(resizeSearchBounds).filter((element) => (
            !movingIds.has(element.id)
            && element.kind !== 'connector'
            && element.kind !== 'stroke'
          )),
          threshold: 6 / input.viewport.zoom,
        })
        interaction.session.update(resizeWhiteboardElements({
          elements: interaction.before,
          fromCenter: pointer.altKey,
          handle: interaction.handle,
          lockAspectRatio: pointer.shiftKey,
          point: resizeSnap.point,
          selectionBounds: interaction.selectionBounds,
        }))
        setSnapGuides(resizeSnap.guides)
        break
      }
      case 'rotating':
        interaction.session.update(rotateWhiteboardElements({
          elements: interaction.before,
          origin: interaction.origin,
          point: pointer.world,
          snap: pointer.shiftKey,
          start: interaction.startWorld,
        }))
        break
      case 'brushing':
        setDraft({
          kind: 'selection',
          start: interaction.startWorld,
          current: pointer.world,
        })
        break
      case 'drawing-shape':
        setDraft({
          kind: 'rectangle',
          start: interaction.startWorld,
          current: pointer.world,
          shapeStyle: interaction.shapeStyle,
          shapeType: interaction.shapeType,
          style: interaction.style,
        })
        break
      case 'connecting':
        setDraft({
          kind: 'connector',
          start: interaction.startWorld,
          current: pointer.world,
          style: interaction.style,
        })
        break
      case 'drawing-stroke': {
        const previous = interaction.points.at(-1)
        if (!previous || Math.hypot(
          pointer.world.x - previous.x,
          pointer.world.y - previous.y,
        ) >= 1.5 / input.viewport.zoom) {
          interaction.points.push(pointer.world)
          setDraft({
            kind: 'stroke',
            points: [...interaction.points],
            style: interaction.style,
          })
        }
        break
      }
    }
  }, [input, machine])

  const endPointer = useCallback((
    world: WhiteboardPoint,
    targetElementId?: string,
  ): PointerEndResult => {
    const interaction = machine.reset()
    setDraft(null)
    setSnapGuides([])
    setInteractionState('idle')

    switch (interaction.type) {
      case 'idle':
        break
      case 'translating':
        if (interaction.moved) {
          const rootIds = new Set(interaction.rootIds)
          const movingIds = new Set(interaction.current.map((element) => element.id))
          const reparented = interaction.current.map((element) => {
            if (!rootIds.has(element.id)) return element
            const frame = getBoardFrameAtPoint(
              input.elements,
              getWhiteboardElementCenter(element),
              movingIds,
            )
            const currentParent = element.parentId
              ? input.elements.find((candidate) => candidate.id === element.parentId)
              : undefined
            const parentId = frame?.id
              || (isBoardFrameElement(currentParent) ? undefined : element.parentId)
            return parentId === element.parentId ? element : { ...element, parentId }
          })
          interaction.current = reparented
          interaction.session.update(interaction.current)
          interaction.session.commit()
        } else interaction.session.cancel()
        if (interaction.duplicateMark) {
          input.store.squashToMark(interaction.duplicateMark, 'Duplicate elements')
        }
        break
      case 'resizing':
      case 'rotating':
        interaction.session.commit()
        break
      case 'brushing': {
        const bounds = normalizeWhiteboardBounds(interaction.startWorld, world)
        if (bounds.width < MIN_BRUSH_SIZE && bounds.height < MIN_BRUSH_SIZE) break
        const selected = input.queryElements(bounds)
          .filter((element) => whiteboardBoundsIntersect(
            bounds,
            getWhiteboardElementBounds(element),
          ))
          .map((element) => resolveBoardSelectableElementId(input.elements, element.id))
        input.setSelectedElementIds([
          ...new Set(getBoardSelectionRootIds(
            input.elements,
            [...interaction.initialSelection, ...selected],
          )),
        ])
        break
      }
      case 'drawing-shape': {
        let bounds = normalizeWhiteboardBounds(interaction.startWorld, world)
        if (bounds.width < MIN_DRAW_SIZE || bounds.height < MIN_DRAW_SIZE) {
          const defaultSize = getBoardRectangleDefaultSize({
            shapeStyle: interaction.shapeStyle,
            shapeType: interaction.shapeType,
          })
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
            parentId: getBoardFrameAtPoint(input.elements, {
              x: bounds.x + bounds.width / 2,
              y: bounds.y + bounds.height / 2,
            })?.id,
            rotation: 0,
            shapeStyle: interaction.shapeStyle,
            shapeType: interaction.shapeType,
            style: interaction.style,
            ...bounds,
          }
          input.commands.execute({ type: 'element.create', elements: [element] })
          input.replaceSelection([element.id])
          input.setTool('select')
          return interaction.placement === 'note' ? { editElement: element } : {}
        }
        input.setTool('select')
        break
      }
      case 'connecting': {
        const endBinding = getBoardConnectorAnchor(
          input.elements.find((element) => element.id === targetElementId),
          world,
        ) || undefined
        const endWorld = endBinding?.point || world
        if (Math.hypot(
          endWorld.x - interaction.startWorld.x,
          endWorld.y - interaction.startWorld.y,
        ) >= MIN_DRAW_SIZE) {
          const element: Extract<WhiteboardElement, { kind: 'connector' }> = {
            id: createWhiteboardElementId('connector'),
            kind: 'connector',
            locked: false,
            parentId: getBoardFrameAtPoint(input.elements, {
              x: (interaction.startWorld.x + endWorld.x) / 2,
              y: (interaction.startWorld.y + endWorld.y) / 2,
            })?.id,
            rotation: 0,
            start: interaction.startWorld,
            end: endWorld,
            style: interaction.style,
          }
          input.commands.execute({
            type: 'connector.create',
            element,
            bindings: [
              ...(interaction.startBinding
                ? [{ anchor: interaction.startBinding, terminal: 'start' as const }]
                : []),
              ...(endBinding
                ? [{ anchor: endBinding, terminal: 'end' as const }]
                : []),
            ],
          })
          input.replaceSelection([element.id])
        }
        input.setTool('select')
        break
      }
      case 'drawing-stroke':
        if (interaction.points.length > 1) {
          const points = simplifyBoardFreehandPoints(
            interaction.points,
            Math.max(0.5, 1.25 / input.viewport.zoom),
          )
          const element: WhiteboardElement = {
            id: createWhiteboardElementId('stroke'),
            kind: 'stroke',
            locked: false,
            parentId: getBoardFrameAtPoint(
              input.elements,
              getWhiteboardElementCenter({
                id: 'draft:stroke',
                kind: 'stroke',
                points,
              }),
            )?.id,
            rotation: 0,
            points,
            style: interaction.style,
          }
          input.commands.execute({ type: 'element.create', elements: [element] })
          input.replaceSelection([element.id])
        }
        break
      case 'panning':
        input.recordViewportHistory(interaction.viewport)
        break
    }
    return {}
  }, [input, machine])

  const currentInteraction = machine.getState()
  return {
    activeResizeHandle: currentInteraction.type === 'resizing'
      ? currentInteraction.handle
      : null,
    beginCanvasPointer,
    beginElementPointer,
    beginResizePointer,
    beginRotatePointer,
    cancelInteraction,
    draft,
    endPointer,
    interactionState,
    movePointer,
    selectElement,
    snapGuides,
  }
}

function cancelBoardInteraction(
  interaction: BoardInteractionState,
  store: BoardStore,
) {
  if (!isBoardTransformInteraction(interaction)) return
  interaction.session.cancel()
  if (interaction.type === 'translating' && interaction.duplicateMark) {
    store.bailToMark(interaction.duplicateMark)
  }
}

function expandWhiteboardBounds(bounds: WhiteboardBounds, margin: number) {
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  }
}
