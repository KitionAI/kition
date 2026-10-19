import { createContext, useContext, type ReactNode } from 'react'

import type { BoardFrameSnapshot } from './lib/boardFrameExport'

/**
 * What the board editor asks of the app it runs in. Every member is optional: a missing one hides
 * what needs it (the image button, Create design), and images then show only URLs that load by
 * themselves (`http(s):`, `data:`, `blob:`). Kition's implementation is in
 * src/features/whiteboard/host; the Board kit's in packages/board-kit/web.
 */
export type BoardHost = {
  /** The URL an image element's `workspacePath` loads from (a path in the app's files). */
  resolveFileURL?: (path: string) => string
  /**
   * Keeps an image file the person picked (the `index`th of this editor) where image elements
   * can point at it, and answers that path.
   */
  importImage?: (file: File, index: number) => Promise<{ path: string }>
  /** Starts a design from a board frame. */
  designFromFrame?: (snapshot: BoardFrameSnapshot) => void
}

const SELF_CONTAINED_URL = /^(https?:|data:|blob:)/i

const BoardHostContext = createContext<BoardHost>({})

export function BoardHostProvider({ children, value }: { children: ReactNode; value: BoardHost }) {
  return <BoardHostContext.Provider value={value}>{children}</BoardHostContext.Provider>
}

export function useBoardHost() {
  return useContext(BoardHostContext)
}

/** The URL an image element shows: the host's, or the path itself when it loads by itself. */
export function boardFileURL(host: BoardHost, path: string) {
  if (host.resolveFileURL) return host.resolveFileURL(path)
  return SELF_CONTAINED_URL.test(path) ? path : ''
}
