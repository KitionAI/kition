import type { BoardRecord } from '../lib/boardRecords'
import type {
  WhiteboardElementStyle,
  WhiteboardTool,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'

export type WhiteboardTestSnapshot = {
  activeStyle: WhiteboardElementStyle
  canRedo: boolean
  canUndo: boolean
  currentPageId: string
  interactionState: string
  path: string
  records: BoardRecord[]
  selectedElementIds: string[]
  shapeType: string
  tool: WhiteboardTool
  viewport: WhiteboardViewport
}

declare global {
  interface Window {
    __KITION_WHITEBOARD_TEST__?: {
      read: () => WhiteboardTestSnapshot
    }
  }
}

export function installWhiteboardTestBridge(read: () => WhiteboardTestSnapshot) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => undefined
  const bridge = { read }
  window.__KITION_WHITEBOARD_TEST__ = bridge
  return () => {
    if (window.__KITION_WHITEBOARD_TEST__ === bridge) {
      delete window.__KITION_WHITEBOARD_TEST__
    }
  }
}

export function cloneWhiteboardTestRecords(records: readonly BoardRecord[]) {
  return JSON.parse(JSON.stringify(records)) as BoardRecord[]
}
