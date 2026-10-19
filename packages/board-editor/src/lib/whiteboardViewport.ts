import type { WhiteboardViewport } from './whiteboardTypes'
import { clampWhiteboardZoom } from './whiteboardGeometry'

export const DEFAULT_WHITEBOARD_VIEWPORT: WhiteboardViewport = { x: 0, y: 0, zoom: 1 }

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Normalises a loosely-typed viewport (e.g. parsed from JSON, or passed in
 * by a caller) into a safe `WhiteboardViewport`: a non-finite `x`/`y` falls
 * back to the matching field on `fallback`, and `zoom` falls back to
 * `fallback.zoom` before being clamped to the editor's supported zoom range
 * with `clampWhiteboardZoom`.
 */
export function normalizeWhiteboardViewport(
  value: unknown,
  fallback: WhiteboardViewport = DEFAULT_WHITEBOARD_VIEWPORT,
): WhiteboardViewport {
  if (typeof value !== 'object' || value === null) return fallback
  const candidate = value as Record<string, unknown>
  return {
    x: finiteNumber(candidate.x) ?? fallback.x,
    y: finiteNumber(candidate.y) ?? fallback.y,
    zoom: clampWhiteboardZoom(finiteNumber(candidate.zoom) ?? fallback.zoom),
  }
}
