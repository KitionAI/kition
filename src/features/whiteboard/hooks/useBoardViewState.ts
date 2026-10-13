import { useCallback, useEffect, useRef, useState } from 'react'

import type { WhiteboardViewport } from '../lib/whiteboardTypes'
import { DEFAULT_WHITEBOARD_VIEWPORT } from './useWhiteboardCamera'

const VIEWPORT_WRITE_DEBOUNCE_MS = 300

type BoardViewState = {
  viewport: WhiteboardViewport
  activePageId: string | null
}

const defaultBoardViewState: BoardViewState = {
  viewport: DEFAULT_WHITEBOARD_VIEWPORT,
  activePageId: null,
}

function storageKeyFor(docId: string) {
  return `kition.board.view.${docId}`
}

function isWhiteboardViewport(value: unknown): value is WhiteboardViewport {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.x === 'number'
    && typeof candidate.y === 'number'
    && typeof candidate.zoom === 'number'
  )
}

function readStoredBoardViewState(docId: string): BoardViewState {
  if (typeof window === 'undefined') return defaultBoardViewState

  const raw = window.localStorage.getItem(storageKeyFor(docId))
  if (!raw) return defaultBoardViewState

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return defaultBoardViewState
    const candidate = parsed as Record<string, unknown>
    const viewport = isWhiteboardViewport(candidate.viewport)
      ? candidate.viewport
      : DEFAULT_WHITEBOARD_VIEWPORT
    const activePageId = typeof candidate.activePageId === 'string'
      ? candidate.activePageId
      : null
    return { viewport, activePageId }
  } catch {
    return defaultBoardViewState
  }
}

function writeStoredBoardViewState(docId: string, state: BoardViewState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKeyFor(docId), JSON.stringify(state))
}

/**
 * Resolves the active page id to restore: the stored id if its page still
 * exists, otherwise the document's first page (or `null` for an empty
 * document).
 */
export function resolveActivePageId(
  stored: string | null,
  pageIds: readonly string[],
): string | null {
  if (stored !== null && pageIds.includes(stored)) return stored
  return pageIds[0] ?? null
}

/**
 * Per-user viewport and current-page state for a whiteboard document, kept
 * in `localStorage` under `kition.board.view.<docId>`. Viewport writes are
 * debounced (300 ms) and flushed on unmount or when `docId` changes; a null
 * `docId` keeps state in memory only (nothing is read or written).
 */
export function useBoardViewState(docId: string | null) {
  const [state, setState] = useState<BoardViewState>(() =>
    docId ? readStoredBoardViewState(docId) : defaultBoardViewState,
  )

  const docIdRef = useRef(docId)
  // The authoritative value for persistence. It is updated synchronously by
  // the setters below (never only through a render pass), so a debounced
  // write always sees the latest value even if React has not yet committed
  // the matching re-render.
  const stateRef = useRef(state)

  const writeTimerRef = useRef<number | undefined>(undefined)

  const flush = useCallback(() => {
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = undefined
    }
    const currentDocId = docIdRef.current
    if (!currentDocId) return
    writeStoredBoardViewState(currentDocId, stateRef.current)
  }, [])

  useEffect(() => {
    if (docIdRef.current === docId) return
    // Flush any pending debounced write for the previous document before
    // switching keys, then load state for the new one.
    flush()
    docIdRef.current = docId
    const next = docId ? readStoredBoardViewState(docId) : defaultBoardViewState
    stateRef.current = next
    setState(next)
  }, [docId, flush])

  useEffect(() => () => flush(), [flush])

  const setViewport = useCallback((next: WhiteboardViewport) => {
    stateRef.current = { ...stateRef.current, viewport: next }
    setState(stateRef.current)

    if (!docIdRef.current) return
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current)
    }
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = undefined
      flush()
    }, VIEWPORT_WRITE_DEBOUNCE_MS)
  }, [flush])

  const setActivePageId = useCallback((next: string | null) => {
    stateRef.current = { ...stateRef.current, activePageId: next }
    setState(stateRef.current)

    const currentDocId = docIdRef.current
    if (!currentDocId) return
    writeStoredBoardViewState(currentDocId, stateRef.current)
  }, [])

  return {
    viewport: state.viewport,
    activePageId: state.activePageId,
    setViewport,
    setActivePageId,
  }
}
