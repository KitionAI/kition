import type { BoardElementUpdateSession } from './boardCommands'
import type {
  BoardConnectorAnchor,
  BoardConnectorTerminal,
} from './boardBindingEngine'
import type { BoardHistoryMark } from './boardStore'
import type {
  WhiteboardBounds,
  WhiteboardConnectorType,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardResizeHandle,
  WhiteboardShapeType,
  WhiteboardViewport,
} from './whiteboardTypes'

type BoardTransformInteraction = {
  before: WhiteboardElement[]
  session: BoardElementUpdateSession
}

export type BoardActiveInteractionState =
  | {
      type: 'panning'
      startScreen: WhiteboardPoint
      viewport: WhiteboardViewport
    }
  | (BoardTransformInteraction & {
      type: 'translating'
      current: WhiteboardElement[]
      startWorld: WhiteboardPoint
      rootIds: string[]
      duplicateMark?: BoardHistoryMark
      moved: boolean
    })
  | (BoardTransformInteraction & {
      type: 'resizing'
      handle: WhiteboardResizeHandle
      selectionBounds: WhiteboardBounds
    })
  | (BoardTransformInteraction & {
      type: 'rotating'
      origin: WhiteboardPoint
      startWorld: WhiteboardPoint
    })
  | {
      type: 'brushing'
      additive: boolean
      initialSelection: string[]
      startWorld: WhiteboardPoint
    }
  | {
      type: 'drawing-shape'
      startWorld: WhiteboardPoint
      shapeStyle?: Extract<WhiteboardElement, { kind: 'rectangle' }>['shapeStyle']
      shapeType: WhiteboardShapeType
      style: WhiteboardElementStyle
      placement: 'shape' | 'note'
    }
  | {
      type: 'connecting'
      connectorType: WhiteboardConnectorType
      startBinding?: BoardConnectorAnchor
      startWorld: WhiteboardPoint
      style: WhiteboardElementStyle
    }
  | {
      type: 'editing-connector'
      connector: Extract<WhiteboardElement, { kind: 'connector' }>
      terminal: BoardConnectorTerminal
    }
  | {
      type: 'drawing-stroke'
      points: WhiteboardPoint[]
      style: WhiteboardElementStyle
      tool: 'pen' | 'highlight'
    }

export type BoardInteractionState =
  | { type: 'idle' }
  | BoardActiveInteractionState

export type BoardInteractionStateName =
  | BoardInteractionState['type']
  | 'editing-text'

export class BoardInteractionMachine {
  private state: BoardInteractionState = { type: 'idle' }

  getState() {
    return this.state
  }

  start(state: BoardActiveInteractionState) {
    if (this.state.type !== 'idle') {
      throw new Error(`Cannot start ${state.type} while ${this.state.type} is active`)
    }
    this.state = state
    return state
  }

  reset() {
    const previous = this.state
    this.state = { type: 'idle' }
    return previous
  }
}

export function isBoardTransformInteraction(
  interaction: BoardInteractionState,
): interaction is Extract<
  BoardActiveInteractionState,
  { type: 'translating' | 'resizing' | 'rotating' }
> {
  return interaction.type === 'translating'
    || interaction.type === 'resizing'
    || interaction.type === 'rotating'
}
