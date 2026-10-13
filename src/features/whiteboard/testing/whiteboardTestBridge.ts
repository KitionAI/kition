import type { Replica } from '@/lib/kdm'

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
  /** The open document's KDM id. */
  docId: string
  interactionState: string
  /** The replica's encoded version (`Version.encode()`) as lowercase hex: changes with every commit or merge. */
  kdmVersion: string
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

/** The replica fields of a test snapshot. */
export function readWhiteboardTestReplica(replica: Replica): Pick<WhiteboardTestSnapshot, 'docId' | 'kdmVersion'> {
  const version = replica.version().encode()
  return {
    docId: replica.docId,
    kdmVersion: Array.from(version, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
}

export function cloneWhiteboardTestRecords(records: readonly BoardRecord[]) {
  return JSON.parse(JSON.stringify(records)) as BoardRecord[]
}
