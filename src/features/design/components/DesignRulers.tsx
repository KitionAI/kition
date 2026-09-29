import { rulerTicks } from '../lib/designRulers'

const SIZE = 20

/** Rulers along the top and left edges, in artboard units at the current zoom. */
export function DesignRulers({
  width,
  height,
  zoom,
  origin,
}: {
  width: number
  height: number
  zoom: number
  origin: { x: number; y: number }
}) {
  const x = rulerTicks(width, zoom)
  const y = rulerTicks(height, zoom)
  return (
    <>
      <svg
        className="design-ruler design-ruler-x"
        data-testid="design-ruler-x"
        aria-hidden="true"
        height={SIZE}
      >
        {x.minor.map((value) => (
          <line key={`m${value}`} x1={origin.x + value * zoom} x2={origin.x + value * zoom} y1={SIZE - 4} y2={SIZE} />
        ))}
        {x.major.map((value) => (
          <g key={value}>
            <line x1={origin.x + value * zoom} x2={origin.x + value * zoom} y1={SIZE - 9} y2={SIZE} />
            <text x={origin.x + value * zoom + 3} y={10}>
              {value}
            </text>
          </g>
        ))}
      </svg>
      <svg
        className="design-ruler design-ruler-y"
        data-testid="design-ruler-y"
        aria-hidden="true"
        width={SIZE}
      >
        {y.minor.map((value) => (
          <line key={`m${value}`} y1={origin.y + value * zoom} y2={origin.y + value * zoom} x1={SIZE - 4} x2={SIZE} />
        ))}
        {y.major.map((value) => (
          <g key={value}>
            <line y1={origin.y + value * zoom} y2={origin.y + value * zoom} x1={SIZE - 9} x2={SIZE} />
            <text transform={`translate(10 ${origin.y + value * zoom + 3}) rotate(-90)`} textAnchor="end">
              {value}
            </text>
          </g>
        ))}
      </svg>
    </>
  )
}
