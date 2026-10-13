import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WhiteboardViewport } from '../lib/whiteboardTypes'
import { normalizeWhiteboardViewport } from '../lib/whiteboardViewport'
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

// `localStorage` can throw (private browsing, disabled storage, quota
// exceeded, etc.). Persistence is best-effort: on failure we fall back to
// in-memory state only, and never let the error escape to the caller.
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore — see comment above.
  }
}

function readStoredBoardViewState(docId: string): BoardViewState {
  if (typeof window === 'undefined') return defaultBoardViewState

  const raw = safeGetItem(storageKeyFor(docId))
  if (!raw) return defaultBoardViewState

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return defaultBoardViewState
    const candidate = parsed as Record<string, unknown>
    const viewport = normalizeWhiteboardViewport(candidate.viewport, DEFAULT_WHITEBOARD_VIEWPORT)
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
  safeSetItem(storageKeyFor(docId), JSON.stringify(state))
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
 * debounced (300 ms) and flushed on unmount or when `docId` changes (only
 * when a write is actually pending); a null `docId` keeps state in memory
 * only (nothing is read or written).
 *
 * The switch to a new `docId` is resolved synchronously during render
 * (rather than in an effect): this guarantees that by the time ANY effect
 * runs in the same commit — including a child effect that fits the camera
 * to the newly loaded document and calls `setViewport` — the hook's setters
 * already target the new document, never the old one. The previous
 * document's pending debounced write is flushed under its OWN key before
 * the switch happens.
 */
export function useBoardViewState(docId: string | null) {
  const [state, setState] = useState<BoardViewState>(() =>
    docId ? readStoredBoardViewState(docId) : defaultBoardViewState,
  )
  // Tracks which docId `state` (and the refs below) belong to. Comparing
  // this (render-tracked) value against the `docId` prop, and resetting
  // during render when they differ, is what makes the switch happen before
  // any effect can run — see the hook's doc comment above.
  const [stateDocId, setStateDocId] = useState(docId)

  const docIdRef = useRef(docId)
  // The authoritative value for persistence. It is updated synchronously by
  // the setters below (never only through a render pass), so a debounced
  // write always sees the latest value even if React has not yet committed
  // the matching re-render.
  const stateRef = useRef(state)
  // Whether `stateRef.current`'s viewport has a change that has not yet
  // been written to storage. Flushing (unmount, docId switch, or the
  // debounce timer) is a no-op while this is false, so mounting/unmounting
  // or switching documents without ever calling a setter writes nothing.
  const pendingRef = useRef(false)

  const writeTimerRef = useRef<number | undefined>(undefined)

  const flushFor = useCallback((targetDocId: string | null, value: BoardViewState) => {
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = undefined
    }
    if (!pendingRef.current) return
    pendingRef.current = false
    if (!targetDocId) return
    writeStoredBoardViewState(targetDocId, value)
  }, [])

  const flush = useCallback(() => {
    flushFor(docIdRef.current, stateRef.current)
  }, [flushFor])

  if (stateDocId !== docId) {
    // Flush the previous document's pending write under ITS OWN key before
    // switching keys, then load state for the new document. Doing this
    // during render (not in an effect) means `docIdRef`/`stateRef` are
    // already correct for `docId` before any effect in this commit runs.
    flushFor(docIdRef.current, stateRef.current)
    const next = docId ? readStoredBoardViewState(docId) : defaultBoardViewState
    docIdRef.current = docId
    stateRef.current = next
    setStateDocId(docId)
    setState(next)
  }

  useEffect(() => () => flush(), [flush])

  const setViewport = useCallback((next: WhiteboardViewport) => {
    const normalized = normalizeWhiteboardViewport(next, stateRef.current.viewport)
    stateRef.current = { ...stateRef.current, viewport: normalized }
    setState(stateRef.current)

    const currentDocId = docIdRef.current
    if (!currentDocId) return
    pendingRef.current = true
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current)
    }
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = undefined
      flushFor(docIdRef.current, stateRef.current)
    }, VIEWPORT_WRITE_DEBOUNCE_MS)
  }, [flushFor])

  const setActivePageId = useCallback((next: string | null) => {
    stateRef.current = { ...stateRef.current, activePageId: next }
    setState(stateRef.current)

    const currentDocId = docIdRef.current
    if (!currentDocId) return
    // Written immediately (and includes the latest viewport, since both
    // live in the same `stateRef` value), so nothing is left pending.
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = undefined
    }
    pendingRef.current = false
    writeStoredBoardViewState(currentDocId, stateRef.current)
  }, [])

  return useMemo(() => ({
    viewport: state.viewport,
    activePageId: state.activePageId,
    setViewport,
    setActivePageId,
  }), [state, setViewport, setActivePageId])
}
