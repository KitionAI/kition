import { describe, expect, it } from 'vitest'
import { imageFillCrop, imageFitPatch } from './designImageFit'
import { marginGuides, rulerTicks } from './designRulers'
import { snapDesignSpacing } from './designSpacing'
import { fitDesignTextFontSize } from './designTextFit'
import { createDesignNode } from './designTypes'

describe('rulers and margins', () => {
  it('spaces major ticks at least 48 screen pixels apart and adds minors when they fit', () => {
    const zoomedOut = rulerTicks(1080, 0.25)
    expect(zoomedOut.step).toBe(200)
    expect(zoomedOut.major).toEqual([0, 200, 400, 600, 800, 1000])
    expect(zoomedOut.minor.slice(0, 4)).toEqual([40, 80, 120, 160])
    expect(zoomedOut.minor).not.toContain(200)
    expect(rulerTicks(1000, 0.02)).toEqual({ step: 5000, major: [0], minor: [] })
    const zoomedIn = rulerTicks(200, 2)
    expect(zoomedIn.step).toBe(25)
    expect(zoomedIn.minor.slice(0, 4)).toEqual([5, 10, 15, 20])
    expect(zoomedIn.minor).not.toContain(25)
  })

  it('insets margin guides from every edge', () => {
    expect(marginGuides({ width: 1080, height: 1440 })).toEqual({
      x: [54, 1026],
      y: [54, 1386],
      inset: { x: 54, y: 54, width: 972, height: 1332 },
    })
  })
})

describe('equal spacing guides', () => {
  const a = { x: 100, y: 100, width: 100, height: 100 }
  const b = { x: 300, y: 100, width: 100, height: 100 }
  it('snaps a third box to the right of two boxes at the same gap', () => {
    const moving = { x: 480, y: 100, width: 100, height: 100 }
    const result = snapDesignSpacing(moving, 15, 0, [a, b], 8)
    expect(result.dx).toBe(20)
    expect(result.dy).toBe(0)
    expect(result.guides).toEqual([
      { axis: 'x', gap: 100, spans: [[200, 300], [400, 500]], at: 150 },
    ])
  })
  it('snaps to the left of the pair and leaves far boxes alone', () => {
    const moving = { x: -105, y: 100, width: 100, height: 100 }
    expect(snapDesignSpacing(moving, 0, 0, [a, b], 8).dx).toBe(5)
    expect(snapDesignSpacing({ x: 900, y: 900, width: 10, height: 10 }, 0, 0, [a, b], 8)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    })
  })
})

describe('text fit', () => {
  const node = createDesignNode('text', { text: 'x', fontSize: 100, lineHeight: 1, width: 100, height: 60 })
  const layout = (value: typeof node) => Array.from({ length: Math.ceil(value.fontSize / 30) }, () => ({ text: 'x' }))
  it('shrinks the font until the wrapped lines fit the box', () => {
    expect(fitDesignTextFontSize(node, layout)).toBe(30)
    expect(fitDesignTextFontSize({ ...node, height: 400 }, layout)).toBe(100)
    expect(fitDesignTextFontSize({ ...node, height: 1 }, layout)).toBe(4)
  })
})

describe('image fit and fill', () => {
  const asset = { width: 1000, height: 500 }
  it('fills by cropping the image to the box ratio, centered', () => {
    expect(imageFillCrop(asset, { width: 200, height: 200 })).toEqual({ x: 250, y: 0, width: 500, height: 500 })
    expect(imageFillCrop(asset, { width: 400, height: 100 })).toEqual({ x: 0, y: 125, width: 1000, height: 250 })
  })
  it('fits by shrinking the box to the image ratio around its center', () => {
    const patch = imageFitPatch(asset, { width: 200, height: 200, transform: [1, 0, 0, 1, 50, 50] })
    expect(patch).toEqual({
      width: 200,
      height: 100,
      transform: [1, 0, 0, 1, 50, 100],
      crop: { x: 0, y: 0, width: 1000, height: 500 },
    })
  })
})
