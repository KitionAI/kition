import type { Bounds } from './designTypes'

export type DesignSpacingGuide = {
  axis: 'x' | 'y'
  /** The gap both spans share, in artboard units. */
  gap: number
  /** Two equal spans: [start, end] pairs along the axis. */
  spans: [[number, number], [number, number]]
  /** Where to draw the spans on the other axis. */
  at: number
}

/**
 * Snaps a moving box so its gap to a neighbor equals the gap between that
 * neighbor and the next stationary box along the same axis, the way design
 * tools show "equal spacing" guides. Returns the corrected offsets and the
 * spans to draw.
 */
export function snapDesignSpacing(
  bounds: Bounds,
  dx: number,
  dy: number,
  stationary: readonly Bounds[],
  threshold: number,
): { dx: number; dy: number; guides: DesignSpacingGuide[] } {
  const guides: DesignSpacingGuide[] = []
  const result = { dx, dy }
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height'
    const cross = axis === 'x' ? 'y' : 'x'
    const crossSize = axis === 'x' ? 'height' : 'width'
    const moving = bounds[axis] + (axis === 'x' ? dx : dy)
    const sorted = [...stationary].sort((a, b) => a[axis] - b[axis])
    let best: { distance: number; position: number; guide: DesignSpacingGuide } | null = null
    for (let i = 0; i < sorted.length; i += 1)
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i],
          b = sorted[j]
        const gap = b[axis] - (a[axis] + a[size])
        if (gap < 0) continue
        const candidates: Array<{ position: number; spans: DesignSpacingGuide['spans'] }> = [
          {
            position: b[axis] + b[size] + gap,
            spans: [
              [a[axis] + a[size], b[axis]],
              [b[axis] + b[size], b[axis] + b[size] + gap],
            ],
          },
          {
            position: a[axis] - gap - bounds[size],
            spans: [
              [a[axis] - gap, a[axis]],
              [a[axis] + a[size], b[axis]],
            ],
          },
        ]
        for (const candidate of candidates) {
          const distance = Math.abs(candidate.position - moving)
          if (distance < threshold && (!best || distance < best.distance))
            best = {
              distance,
              position: candidate.position,
              guide: {
                axis,
                gap,
                spans: candidate.spans,
                at: a[cross] + a[crossSize] / 2,
              },
            }
        }
      }
    if (best) {
      result[axis === 'x' ? 'dx' : 'dy'] = best.position - bounds[axis]
      guides.push(best.guide)
    }
  }
  return { ...result, guides }
}
