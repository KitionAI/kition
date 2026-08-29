import { getBoardShapeDefinition } from './boardElementDefinitions'
import { isBoardGroupElement } from './boardHierarchy'
import {
  getWhiteboardConnectorPath,
  getWhiteboardContentBounds,
  getWhiteboardElementCenter,
  whiteboardPointsToPath,
} from './whiteboardGeometry'
import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
} from './whiteboardStyle'
import type {
  WhiteboardColorToken,
  WhiteboardElement,
  WhiteboardRectangleElement,
} from './whiteboardTypes'

const EXPORT_STROKES: Record<WhiteboardColorToken, string> = {
  ink: '#1a1a1a',
  gray: '#787671',
  purple: '#5645d4',
  green: '#1aae39',
  orange: '#dd5b00',
  red: '#e03131',
  yellow: '#c69200',
  blue: '#0075de',
  white: '#ffffff',
}

const EXPORT_FILLS: Record<WhiteboardColorToken, string> = {
  ink: '#e8e8e8',
  gray: '#f0eeec',
  purple: '#e6e0f5',
  green: '#d9f3e1',
  orange: '#ffe8d4',
  red: '#fde0ec',
  yellow: '#fef7d6',
  blue: '#dcecfa',
  white: '#ffffff',
}

export function exportBoardSvg(input: {
  elements: readonly WhiteboardElement[]
  imageHrefs?: ReadonlyMap<string, string>
  padding?: number
  title: string
}) {
  const exportableElements = input.elements.filter((element) => !isBoardGroupElement(element))
  const bounds = getWhiteboardContentBounds(exportableElements)
  if (!bounds) return ''
  const padding = Math.max(0, input.padding ?? 32)
  const viewBox = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
  }
  const body = exportableElements
    .map((element) => exportElement(element, input.imageHrefs))
    .filter(Boolean)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${numbers(viewBox.x, viewBox.y, viewBox.width, viewBox.height)}" width="${number(viewBox.width)}" height="${number(viewBox.height)}">`,
    `<title>${escapeXml(input.title)}</title>`,
    '<defs>',
    '<marker id="kition-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>',
    '<marker id="kition-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><circle cx="5" cy="5" r="4" fill="context-stroke"/></marker>',
    '<pattern id="kition-pattern" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#ffffff"/><path d="M -2 8 L 8 -2 M 2 10 L 10 2" stroke="#bbb8b1" stroke-width="1.5"/></pattern>',
    '</defs>',
    `<rect x="${number(viewBox.x)}" y="${number(viewBox.y)}" width="${number(viewBox.width)}" height="${number(viewBox.height)}" fill="#ffffff"/>`,
    body,
    '</svg>',
    '',
  ].join('\n')
}

function exportElement(
  element: WhiteboardElement,
  imageHrefs: ReadonlyMap<string, string> | undefined,
) {
  const style = getWhiteboardElementStyle(element)
  const strokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
  const stroke = EXPORT_STROKES[style.strokeColor]
  const dash = getWhiteboardDashArray(style.dashStyle, strokeWidth)
  const attributes = [
    `opacity="${number(element.locked ? 0.82 : style.opacity)}"`,
    element.rotation
      ? `transform="rotate(${number(element.rotation)} ${numbers(
          getWhiteboardElementCenter(element).x,
          getWhiteboardElementCenter(element).y,
        )})"`
      : '',
  ].filter(Boolean).join(' ')
  const content = exportElementBody(element, {
    dash,
    fill: style.fillStyle === 'none'
      ? 'none'
      : style.fillStyle === 'pattern'
        ? 'url(#kition-pattern)'
        : EXPORT_FILLS[style.fillColor],
    fillOpacity: style.fillStyle === 'semi' ? 0.48 : 1,
    imageHref: element.kind === 'image'
      ? imageHrefs?.get(element.workspacePath) || element.workspacePath
      : '',
    stroke,
    strokeWidth,
  })
  return content ? `<g ${attributes}>${content}</g>` : ''
}

function exportElementBody(
  element: WhiteboardElement,
  paint: {
    dash?: string
    fill: string
    fillOpacity: number
    imageHref: string
    stroke: string
    strokeWidth: number
  },
) {
  const lineAttributes = [
    `stroke="${paint.stroke}"`,
    `stroke-width="${number(paint.strokeWidth)}"`,
    paint.dash ? `stroke-dasharray="${paint.dash}"` : '',
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    'vector-effect="non-scaling-stroke"',
  ].filter(Boolean).join(' ')
  switch (element.kind) {
    case 'rectangle':
      return exportRectangle(element, paint, lineAttributes)
    case 'text':
      return `<text x="${number(element.x)}" y="${number(element.y)}" fill="${paint.stroke}" font-size="${number(element.fontSize ?? 22)}" font-family="Inter, sans-serif" font-weight="500">${escapeXml(element.text)}</text>`
    case 'stroke':
      return `<path d="${whiteboardPointsToPath(element.points)}" fill="none" ${lineAttributes}/>`
    case 'connector':
      return `<path d="${getWhiteboardConnectorPath(element)}" fill="none" ${lineAttributes}${exportArrowhead('start', element.startArrowhead || 'none')}${exportArrowhead('end', element.endArrowhead || 'arrow')}/>`
    case 'image':
      return [
        `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" rx="8" fill="#fafaf9" ${lineAttributes}/>`,
        `<image href="${escapeXml(paint.imageHref)}" x="${number(element.x + 1)}" y="${number(element.y + 1)}" width="${number(Math.max(0, element.width - 2))}" height="${number(Math.max(0, element.height - 2))}" preserveAspectRatio="xMidYMid meet"/>`,
      ].join('')
  }
}

function exportArrowhead(
  terminal: 'start' | 'end',
  arrowhead: 'none' | 'arrow' | 'dot',
) {
  if (arrowhead === 'none') return ''
  return ` marker-${terminal}="url(#kition-${arrowhead})"`
}

function exportRectangle(
  element: WhiteboardRectangleElement,
  paint: {
    fill: string
    fillOpacity: number
    stroke: string
    strokeWidth: number
  },
  lineAttributes: string,
) {
  const { x, y, width, height } = element
  const right = x + width
  const bottom = y + height
  const centerX = x + width / 2
  const centerY = y + height / 2
  const shapeType = getBoardShapeDefinition(element.shapeType).geometry
  const shapeAttributes = `fill="${paint.fill}" fill-opacity="${number(paint.fillOpacity)}" ${lineAttributes}`
  let geometry = ''
  switch (shapeType) {
    case 'ellipse':
      geometry = `<ellipse cx="${number(centerX)}" cy="${number(centerY)}" rx="${number(width / 2)}" ry="${number(height / 2)}" ${shapeAttributes}/>`
      break
    case 'triangle':
      geometry = `<polygon points="${points([centerX, y], [right, bottom], [x, bottom])}" ${shapeAttributes}/>`
      break
    case 'diamond':
      geometry = `<polygon points="${points([centerX, y], [right, centerY], [centerX, bottom], [x, centerY])}" ${shapeAttributes}/>`
      break
    case 'hexagon': {
      const inset = width * 0.24
      geometry = `<polygon points="${points([x + inset, y], [right - inset, y], [right, centerY], [right - inset, bottom], [x + inset, bottom], [x, centerY])}" ${shapeAttributes}/>`
      break
    }
    case 'parallelogram': {
      const inset = Math.min(width * 0.24, height * 0.6)
      geometry = `<polygon points="${points([x + inset, y], [right, y], [right - inset, bottom], [x, bottom])}" ${shapeAttributes}/>`
      break
    }
    case 'star':
      geometry = `<polygon points="${createStarPoints(centerX, centerY, width, height)}" ${shapeAttributes}/>`
      break
    case 'cloud':
      geometry = `<path d="${createCloudPath(x, y, width, height)}" ${shapeAttributes}/>`
      break
    case 'heart':
      geometry = `<path d="${createHeartPath(x, y, width, height)}" ${shapeAttributes}/>`
      break
    case 'x-box':
      geometry = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" ${shapeAttributes}/><path d="M ${numbers(x, y)} L ${numbers(right, bottom)} M ${numbers(right, y)} L ${numbers(x, bottom)}" fill="none" ${lineAttributes}/>`
      break
    case 'check-box': {
      const size = Math.min(width, height) * 0.82
      const offsetX = x + (width - size) / 2
      const offsetY = y + (height - size) / 2
      geometry = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" ${shapeAttributes}/><path d="M ${numbers(offsetX + size * 0.25, offsetY + size * 0.52)} L ${numbers(offsetX + size * 0.45, offsetY + size * 0.82)} L ${numbers(offsetX + size * 0.82, offsetY + size * 0.22)}" fill="none" ${lineAttributes}/>`
      break
    }
    case 'check':
      geometry = `<path d="M ${numbers(x + width * 0.14, y + height * 0.53)} L ${numbers(x + width * 0.4, y + height * 0.8)} L ${numbers(x + width * 0.87, y + height * 0.2)}" fill="none" ${lineAttributes}/>`
      break
    case 'arrow-left':
      geometry = `<polygon points="${points([x, centerY], [x + width * 0.38, y], [x + width * 0.38, y + height * 0.3], [right, y + height * 0.3], [right, y + height * 0.7], [x + width * 0.38, y + height * 0.7], [x + width * 0.38, bottom])}" ${shapeAttributes}/>`
      break
    case 'arrow-right':
      geometry = `<polygon points="${points([right, centerY], [x + width * 0.62, y], [x + width * 0.62, y + height * 0.3], [x, y + height * 0.3], [x, y + height * 0.7], [x + width * 0.62, y + height * 0.7], [x + width * 0.62, bottom])}" ${shapeAttributes}/>`
      break
    case 'arrow-up':
      geometry = `<polygon points="${points([centerX, y], [right, y + height * 0.38], [x + width * 0.7, y + height * 0.38], [x + width * 0.7, bottom], [x + width * 0.3, bottom], [x + width * 0.3, y + height * 0.38], [x, y + height * 0.38])}" ${shapeAttributes}/>`
      break
    case 'arrow-down':
      geometry = `<polygon points="${points([centerX, bottom], [right, y + height * 0.62], [x + width * 0.7, y + height * 0.62], [x + width * 0.7, y], [x + width * 0.3, y], [x + width * 0.3, y + height * 0.62], [x, y + height * 0.62])}" ${shapeAttributes}/>`
      break
    case 'line':
      geometry = `<line x1="${number(x)}" y1="${number(centerY)}" x2="${number(right)}" y2="${number(centerY)}" fill="none" ${lineAttributes}/>`
      break
    case 'pill':
      geometry = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(height / 2)}" ${shapeAttributes}/>`
      break
    case 'frame':
      geometry = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="4" ${shapeAttributes}/>`
      break
    case 'rectangle':
    default:
      geometry = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(element.shapeStyle === 'sticky' ? 4 : Math.min(12, width / 6, height / 6))}" ${shapeAttributes}/>`
      break
  }
  const label = splitLabel(element.text || '', width)
  if (label.length === 0 || !getBoardShapeDefinition(element.shapeType).supportsLabel) {
    return geometry
  }
  const lineHeight = 18
  const firstLineY = y + height / 2 - ((label.length - 1) * lineHeight) / 2
  const text = label.map((line, index) => (
    `<tspan x="${number(centerX)}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`
  )).join('')
  return `${geometry}<text x="${number(centerX)}" y="${number(firstLineY)}" fill="${paint.stroke}" font-size="15" font-family="Inter, sans-serif" font-weight="${element.shapeStyle === 'mind-node' || element.shapeStyle === 'flow-node' ? 600 : 500}" text-anchor="middle" dominant-baseline="middle">${text}</text>`
}

function createStarPoints(centerX: number, centerY: number, width: number, height: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : 0.43
    const angle = -Math.PI / 2 + (Math.PI * index) / 5
    return `${number(centerX + Math.cos(angle) * width / 2 * radius)},${number(centerY + Math.sin(angle) * height / 2 * radius)}`
  }).join(' ')
}

function createCloudPath(x: number, y: number, width: number, height: number) {
  return `M ${numbers(x + width * 0.2, y + height * 0.72)} C ${numbers(x + width * 0.04, y + height * 0.72, x + width * 0.02, y + height * 0.47, x + width * 0.18, y + height * 0.4)} C ${numbers(x + width * 0.17, y + height * 0.18, x + width * 0.43, y + height * 0.1, x + width * 0.55, y + height * 0.28)} C ${numbers(x + width * 0.72, y + height * 0.15, x + width * 0.93, y + height * 0.31, x + width * 0.87, y + height * 0.51)} C ${numbers(x + width * 1.03, y + height * 0.61, x + width * 0.91, y + height * 0.83, x + width * 0.75, y + height * 0.79)} L ${numbers(x + width * 0.2, y + height * 0.79)} Z`
}

function createHeartPath(x: number, y: number, width: number, height: number) {
  return `M ${numbers(x + width / 2, y + height * 0.9)} C ${numbers(x + width * 0.42, y + height * 0.79, x + width * 0.08, y + height * 0.58, x + width * 0.08, y + height * 0.3)} C ${numbers(x + width * 0.08, y + height * 0.02, x + width * 0.4, y - height * 0.02, x + width / 2, y + height * 0.22)} C ${numbers(x + width * 0.6, y - height * 0.02, x + width * 0.92, y + height * 0.02, x + width * 0.92, y + height * 0.3)} C ${numbers(x + width * 0.92, y + height * 0.58, x + width * 0.58, y + height * 0.79, x + width / 2, y + height * 0.9)} Z`
}

function splitLabel(text: string, width: number) {
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

function points(...values: Array<[number, number]>) {
  return values.map((value) => `${number(value[0])},${number(value[1])}`).join(' ')
}

function numbers(...values: number[]) {
  return values.map(number).join(' ')
}

function number(value: number) {
  return Number(value.toFixed(3)).toString()
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
