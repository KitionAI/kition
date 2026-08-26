import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WhiteboardShapeType } from '../lib/whiteboardTypes'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'

function renderShape(shapeType: WhiteboardShapeType) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <svg>
      <WhiteboardShapeBody
        element={{
          id: `shape:${shapeType}`,
          kind: 'rectangle',
          x: 10,
          y: 20,
          width: 100,
          height: 60,
          shapeType,
          style: {
            fillColor: 'white',
            fillStyle: 'solid',
            strokeColor: 'ink',
            strokeSize: 's',
          },
        }}
        patternId="pattern"
      />
    </svg>,
  )
  return container.querySelector('svg')!
}

function pathNumbers(path: SVGPathElement) {
  return Array.from(path.getAttribute('d')?.matchAll(/-?\d+(?:\.\d+)?/g) || [])
    .map((match) => Number(match[0]))
}

describe('WhiteboardShapeBody', () => {
  it('renders an x-box with square corners and corner-to-corner diagonals', () => {
    const shape = renderShape('x-box')
    const rectangle = shape.querySelector('rect')
    const diagonal = shape.querySelector('path')

    expect(rectangle?.hasAttribute('rx')).toBe(false)
    expect(diagonal).not.toBeNull()
    expect(pathNumbers(diagonal!)).toEqual([
      10.75, 20.75,
      109.25, 79.25,
      109.25, 20.75,
      10.75, 79.25,
    ])
  })

  it('keeps the check mark centered and proportional inside a wide box', () => {
    const shape = renderShape('check-box')
    const rectangle = shape.querySelector('rect')
    const check = shape.querySelector('path')
    const numbers = pathNumbers(check!)

    expect(rectangle?.hasAttribute('rx')).toBe(false)
    expect(numbers).toHaveLength(6)
    expect(numbers[0]).toBeCloseTo(47.7)
    expect(numbers[1]).toBeCloseTo(50.984)
    expect(numbers[2]).toBeCloseTo(57.54)
    expect(numbers[3]).toBeCloseTo(65.744)
    expect(numbers[4]).toBeCloseTo(75.744)
    expect(numbers[5]).toBeCloseTo(36.224)
  })
})
