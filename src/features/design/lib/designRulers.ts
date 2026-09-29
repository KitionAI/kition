import type { Bounds, DesignPage } from './designTypes'

const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]

/**
 * Tick positions for a ruler along one axis, in artboard units. Major ticks
 * stay at least 48 screen pixels apart; minor ticks split each major step
 * in five when they still have room.
 */
export function rulerTicks(length: number, zoom: number): { step: number; major: number[]; minor: number[] } {
  const step = STEPS.find((candidate) => candidate * zoom >= 48) ?? STEPS[STEPS.length - 1]
  const major: number[] = []
  for (let value = 0; value <= length; value += step) major.push(value)
  const minorStep = step / 5
  const minor: number[] = []
  if (minorStep * zoom >= 6)
    for (let value = minorStep; value < length; value += minorStep) if (value % step !== 0) minor.push(value)
  return { step, major, minor }
}

/** Safe-area margins inset from every edge, as snap lines. */
export function marginGuides(page: Pick<DesignPage, 'width' | 'height'>, fraction = 0.05): { x: number[]; y: number[]; inset: Bounds } {
  const inset = Math.round(Math.min(page.width, page.height) * fraction)
  return {
    x: [inset, page.width - inset],
    y: [inset, page.height - inset],
    inset: { x: inset, y: inset, width: page.width - inset * 2, height: page.height - inset * 2 },
  }
}
