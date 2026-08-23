import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import type { WhiteboardRectangleElement } from '../lib/whiteboardTypes'

export function WhiteboardShapeBody({
  element,
  highlighted = false,
  onDoubleClick,
  patternId,
}: {
  element: WhiteboardRectangleElement
  highlighted?: boolean
  onDoubleClick?: () => void
  patternId: string
}) {
  const shapeType = element.shapeType || 'rectangle'
  const style = getWhiteboardElementStyle(element)
  const baseStrokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
  const strokeWidth = highlighted ? Math.max(baseStrokeWidth, 3) : baseStrokeWidth
  const stroke = highlighted
    ? 'hsl(var(--brand))'
    : resolveWhiteboardColor(style.strokeColor, 'stroke')
  const fill = shapeType === 'line' || shapeType === 'check' || style.fillStyle === 'none'
    ? 'none'
    : style.fillStyle === 'pattern'
      ? `url(#${patternId})`
      : resolveWhiteboardColor(style.fillColor, 'fill')
  const shapeProps: WhiteboardShapeGeometryProps = {
    fill,
    fillOpacity: style.fillStyle === 'semi' ? 0.48 : 1,
    stroke,
    strokeDasharray: getWhiteboardDashArray(style.dashStyle, strokeWidth),
    strokeLinecap: style.dashStyle === 'dotted' ? 'round' : 'round',
    strokeLinejoin: 'round',
    strokeWidth,
    vectorEffect: 'non-scaling-stroke',
    onDoubleClick,
  }

  return (
    <>
      <WhiteboardShapeGeometry element={element} shapeProps={shapeProps} />
      <WhiteboardShapeLabel element={element} />
    </>
  )
}

function WhiteboardShapeGeometry({
  element,
  shapeProps,
}: {
  element: WhiteboardRectangleElement
  shapeProps: WhiteboardShapeGeometryProps
}) {
  const { x, y, width, height } = element
  const right = x + width
  const bottom = y + height
  const centerX = x + width / 2
  const centerY = y + height / 2
  const shapeType = element.shapeType || 'rectangle'

  switch (shapeType) {
    case 'ellipse':
      return <ellipse {...shapeProps} cx={centerX} cy={centerY} rx={width / 2} ry={height / 2} />
    case 'triangle':
      return <polygon {...shapeProps} points={`${centerX},${y} ${right},${bottom} ${x},${bottom}`} />
    case 'diamond':
      return <polygon {...shapeProps} points={`${centerX},${y} ${right},${centerY} ${centerX},${bottom} ${x},${centerY}`} />
    case 'hexagon': {
      const inset = width * 0.24
      return <polygon {...shapeProps} points={`${x + inset},${y} ${right - inset},${y} ${right},${centerY} ${right - inset},${bottom} ${x + inset},${bottom} ${x},${centerY}`} />
    }
    case 'parallelogram': {
      const inset = Math.min(width * 0.24, height * 0.6)
      return <polygon {...shapeProps} points={`${x + inset},${y} ${right},${y} ${right - inset},${bottom} ${x},${bottom}`} />
    }
    case 'star':
      return <polygon {...shapeProps} points={createStarPoints(centerX, centerY, width, height)} />
    case 'cloud':
      return <path {...shapeProps} d={createCloudPath(x, y, width, height)} />
    case 'heart':
      return <path {...shapeProps} d={createHeartPath(x, y, width, height)} />
    case 'check':
      return <path {...shapeProps} d={`M ${x + width * 0.14} ${y + height * 0.53} L ${x + width * 0.4} ${y + height * 0.8} L ${x + width * 0.87} ${y + height * 0.2}`} />
    case 'arrow-left':
      return <polygon {...shapeProps} points={`${x},${centerY} ${x + width * 0.38},${y} ${x + width * 0.38},${y + height * 0.3} ${right},${y + height * 0.3} ${right},${y + height * 0.7} ${x + width * 0.38},${y + height * 0.7} ${x + width * 0.38},${bottom}`} />
    case 'arrow-right':
      return <polygon {...shapeProps} points={`${right},${centerY} ${x + width * 0.62},${y} ${x + width * 0.62},${y + height * 0.3} ${x},${y + height * 0.3} ${x},${y + height * 0.7} ${x + width * 0.62},${y + height * 0.7} ${x + width * 0.62},${bottom}`} />
    case 'arrow-up':
      return <polygon {...shapeProps} points={`${centerX},${y} ${right},${y + height * 0.38} ${x + width * 0.7},${y + height * 0.38} ${x + width * 0.7},${bottom} ${x + width * 0.3},${bottom} ${x + width * 0.3},${y + height * 0.38} ${x},${y + height * 0.38}`} />
    case 'arrow-down':
      return <polygon {...shapeProps} points={`${centerX},${bottom} ${right},${y + height * 0.62} ${x + width * 0.7},${y + height * 0.62} ${x + width * 0.7},${y} ${x + width * 0.3},${y} ${x + width * 0.3},${y + height * 0.62} ${x},${y + height * 0.62}`} />
    case 'line':
      return <line {...shapeProps} x1={x} y1={centerY} x2={right} y2={centerY} />
    case 'pill':
      return <rect {...shapeProps} x={x} y={y} width={width} height={height} rx={height / 2} />
    case 'frame':
      return <rect {...shapeProps} x={x} y={y} width={width} height={height} rx={4} />
    case 'rectangle':
    default:
      return (
        <rect
          {...shapeProps}
          x={x}
          y={y}
          width={width}
          height={height}
          rx={element.shapeStyle === 'sticky'
            ? 4
            : Math.min(12, width / 6, height / 6)}
        />
      )
  }
}

type WhiteboardShapeGeometryProps = {
  fill: string
  fillOpacity: number
  onDoubleClick?: () => void
  stroke: string
  strokeDasharray?: string
  strokeLinecap: 'round'
  strokeLinejoin: 'round'
  strokeWidth: number
  vectorEffect: 'non-scaling-stroke'
}

function WhiteboardShapeLabel({ element }: { element: WhiteboardRectangleElement }) {
  const lines = splitWhiteboardLabel(element.text || '', element.width)
  if (!lines.length || element.shapeType === 'line' || element.shapeType === 'check') return null
  const lineHeight = 18
  const firstLineY = element.y + element.height / 2 - ((lines.length - 1) * lineHeight) / 2
  return (
    <text
      x={element.x + element.width / 2}
      y={firstLineY}
      fill={resolveWhiteboardColor(getWhiteboardElementStyle(element).strokeColor, 'stroke')}
      fontSize="15"
      fontWeight={element.shapeStyle === 'mind-node' || element.shapeStyle === 'flow-node' ? '600' : '500'}
      textAnchor="middle"
      dominantBaseline="middle"
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <tspan
          key={`${line}-${index}`}
          x={element.x + element.width / 2}
          dy={index === 0 ? 0 : lineHeight}
        >
          {line}
        </tspan>
      ))}
    </text>
  )
}

function createStarPoints(centerX: number, centerY: number, width: number, height: number) {
  const outerX = width / 2
  const outerY = height / 2
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : 0.43
    const angle = -Math.PI / 2 + (Math.PI * index) / 5
    return `${centerX + Math.cos(angle) * outerX * radius},${centerY + Math.sin(angle) * outerY * radius}`
  }).join(' ')
}

function createCloudPath(x: number, y: number, width: number, height: number) {
  return [
    `M ${x + width * 0.2} ${y + height * 0.72}`,
    `C ${x + width * 0.04} ${y + height * 0.72}, ${x + width * 0.02} ${y + height * 0.47}, ${x + width * 0.18} ${y + height * 0.4}`,
    `C ${x + width * 0.17} ${y + height * 0.18}, ${x + width * 0.43} ${y + height * 0.1}, ${x + width * 0.55} ${y + height * 0.28}`,
    `C ${x + width * 0.72} ${y + height * 0.15}, ${x + width * 0.93} ${y + height * 0.31}, ${x + width * 0.87} ${y + height * 0.51}`,
    `C ${x + width * 1.03} ${y + height * 0.61}, ${x + width * 0.91} ${y + height * 0.83}, ${x + width * 0.75} ${y + height * 0.79}`,
    `L ${x + width * 0.2} ${y + height * 0.79} Z`,
  ].join(' ')
}

function createHeartPath(x: number, y: number, width: number, height: number) {
  return [
    `M ${x + width / 2} ${y + height * 0.9}`,
    `C ${x + width * 0.42} ${y + height * 0.79}, ${x + width * 0.08} ${y + height * 0.58}, ${x + width * 0.08} ${y + height * 0.3}`,
    `C ${x + width * 0.08} ${y + height * 0.02}, ${x + width * 0.4} ${y - height * 0.02}, ${x + width / 2} ${y + height * 0.22}`,
    `C ${x + width * 0.6} ${y - height * 0.02}, ${x + width * 0.92} ${y + height * 0.02}, ${x + width * 0.92} ${y + height * 0.3}`,
    `C ${x + width * 0.92} ${y + height * 0.58}, ${x + width * 0.58} ${y + height * 0.79}, ${x + width / 2} ${y + height * 0.9} Z`,
  ].join(' ')
}

function splitWhiteboardLabel(text: string, width: number) {
  const normalized = text.trim()
  if (!normalized) return []
  const maxCharacters = Math.max(6, Math.floor((width - 24) / 8))
  const words = normalized.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) current = word
    else if (`${current} ${word}`.length <= maxCharacters) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
    if (lines.length === 2) break
  }
  if (current && lines.length < 3) lines.push(current)
  if (lines.length === 3 && words.join(' ').length > lines.join(' ').length) {
    lines[2] = `${lines[2].slice(0, Math.max(1, maxCharacters - 1))}…`
  }
  return lines
}
