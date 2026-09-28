import { describe, expect, it } from 'vitest'
import { applyDesignCommand } from './designCommands'
import { selectionBounds } from './designGeometry'
import { alignMoves, artboardResizeMoves, distributeMoves } from './designLayout'
import { createDesign, createDesignNode, type DesignConstraints, type DesignDocument } from './designTypes'

function fixture(): DesignDocument {
  const doc = createDesign('Layout', 1000, 2000)
  const nodes = [
    createDesignNode('rectangle', { id: 'a', transform: [1, 0, 0, 1, 100, 100], width: 100, height: 50 }),
    createDesignNode('rectangle', { id: 'b', transform: [1, 0, 0, 1, 400, 300], width: 200, height: 100 }),
    createDesignNode('rectangle', { id: 'c', transform: [1, 0, 0, 1, 900, 900], width: 50, height: 50 }),
  ]
  for (const node of nodes) {
    doc.nodes[node.id] = node
    doc.pages[0].children.push(node.id)
  }
  return doc
}

const box = (doc: DesignDocument, id: string) => selectionBounds(doc, [id])

describe('alignMoves', () => {
  it.each([
    ['left', { a: 100, b: 100, c: 100 }, 'x'],
    ['right', { a: 850, b: 750, c: 900 }, 'x'],
    ['centerX', { a: 475, b: 425, c: 500 }, 'x'],
    ['top', { a: 100, b: 100, c: 100 }, 'y'],
    ['bottom', { a: 900, b: 850, c: 900 }, 'y'],
    ['centerY', { a: 500, b: 475, c: 500 }, 'y'],
  ] as const)('aligns %s within the selection bounds', (edge, expected, axis) => {
    const doc = applyDesignCommand(fixture(), { type: 'align', ids: ['a', 'b', 'c'], edge })
    for (const [id, value] of Object.entries(expected)) expect(box(doc, id)[axis]).toBeCloseTo(value)
  })

  it('aligns against the artboard when asked or when one layer is selected', () => {
    const artboard = applyDesignCommand(fixture(), { type: 'align', ids: ['a', 'b'], edge: 'right', reference: 'artboard' })
    expect(box(artboard, 'a').x + box(artboard, 'a').width).toBe(1000)
    expect(box(artboard, 'b').x + box(artboard, 'b').width).toBe(1000)
    const single = applyDesignCommand(fixture(), { type: 'align', ids: ['a'], edge: 'centerY' })
    expect(box(single, 'a').y).toBe(975)
  })

  it('returns no moves for layers already aligned', () => {
    const doc = fixture()
    expect(alignMoves(doc, ['a', 'b', 'c'], 'left').has('b')).toBe(true)
    expect(alignMoves(doc, ['b'], 'left', 'selection').has('b')).toBe(true)
    expect(alignMoves(applyDesignCommand(doc, { type: 'align', ids: ['a'], edge: 'left' }), ['a'], 'left').size).toBe(0)
  })
})

describe('distributeMoves', () => {
  it('spaces three layers with equal gaps and keeps the outer ones fixed', () => {
    const doc = applyDesignCommand(fixture(), { type: 'distribute', ids: ['a', 'b', 'c'], axis: 'x' })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => box(doc, id))
    expect(a.x).toBe(100)
    expect(c.x).toBe(900)
    expect(b.x - (a.x + a.width)).toBeCloseTo(c.x - (b.x + b.width))
  })

  it('distributes vertically and ignores fewer than three layers', () => {
    const doc = applyDesignCommand(fixture(), { type: 'distribute', ids: ['a', 'b', 'c'], axis: 'y' })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => box(doc, id))
    expect(b.y - (a.y + a.height)).toBeCloseTo(c.y - (b.y + b.height))
    expect(distributeMoves(fixture(), ['a', 'b'], 'x').size).toBe(0)
  })
})

describe('artboardResizeMoves', () => {
  const cases: Array<[DesignConstraints, { x: number; y: number; width: number; height: number }]> = [
    [{ horizontal: 'left', vertical: 'top' }, { x: 400, y: 300, width: 200, height: 100 }],
    [{ horizontal: 'right', vertical: 'bottom' }, { x: 1400, y: 1300, width: 200, height: 100 }],
    [{ horizontal: 'center', vertical: 'center' }, { x: 900, y: 800, width: 200, height: 100 }],
    [{ horizontal: 'scale', vertical: 'scale' }, { x: 800, y: 450, width: 400, height: 150 }],
  ]
  it.each(cases)('reflows %o when the artboard grows', (constraints, expected) => {
    const doc = fixture()
    doc.nodes.b.constraints = constraints
    const resized = applyDesignCommand(doc, { type: 'page', patch: { width: 2000, height: 3000 } })
    const bounds = box(resized, 'b')
    expect(bounds.x).toBeCloseTo(expected.x)
    expect(bounds.y).toBeCloseTo(expected.y)
    expect(bounds.width).toBeCloseTo(expected.width)
    expect(bounds.height).toBeCloseTo(expected.height)
    expect(resized.pages[0].width).toBe(2000)
  })

  it('keeps a centered headline centered when switching poster to story', () => {
    const doc = createDesign('Poster', 1080, 1440)
    const heading = createDesignNode('text', {
      id: 'h',
      transform: [1, 0, 0, 1, 240, 100],
      width: 600,
      height: 80,
      constraints: { horizontal: 'center', vertical: 'top' },
    })
    doc.nodes.h = heading
    doc.pages[0].children.push('h')
    const story = applyDesignCommand(doc, { type: 'page', patch: { height: 1920 } })
    expect(box(story, 'h')).toEqual({ x: 240, y: 100, width: 600, height: 80 })
    const wide = applyDesignCommand(doc, { type: 'page', patch: { width: 1920, height: 1080 } })
    expect(box(wide, 'h').x + 300).toBe(960)
  })

  it('leaves legacy layers without constraints in place and treats identical sizes as a no-op', () => {
    const doc = fixture()
    delete doc.nodes.a.constraints
    expect(artboardResizeMoves(doc, { width: 1000, height: 2000 }).size).toBe(0)
    expect(artboardResizeMoves(doc, { width: 500, height: 500 }).has('a')).toBe(false)
  })
})
