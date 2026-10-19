import type {
  WhiteboardColorToken,
  WhiteboardDashStyle,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardFillStyle,
  WhiteboardStrokeSize,
} from './whiteboardTypes'
import { getBoardElementSemanticStyle } from './boardElementDefinitions'

export const DEFAULT_WHITEBOARD_STYLE: WhiteboardElementStyle = {
  strokeColor: 'ink',
  fillColor: 'white',
  opacity: 1,
  fillStyle: 'solid',
  dashStyle: 'solid',
  strokeSize: 'm',
}

export const DEFAULT_WHITEBOARD_HIGHLIGHT_STYLE: WhiteboardElementStyle = {
  ...DEFAULT_WHITEBOARD_STYLE,
  strokeColor: 'yellow',
  fillColor: 'yellow',
  opacity: 0.45,
  dashStyle: 'solid',
  strokeSize: 'xl',
}

export const WHITEBOARD_COLOR_TOKENS: readonly WhiteboardColorToken[] = [
  'ink',
  'gray',
  'purple',
  'green',
  'orange',
  'red',
  'yellow',
  'blue',
  'white',
]

export const WHITEBOARD_FILL_STYLES: readonly WhiteboardFillStyle[] = [
  'none',
  'solid',
  'semi',
  'pattern',
]

export const WHITEBOARD_DASH_STYLES: readonly WhiteboardDashStyle[] = [
  'solid',
  'dashed',
  'dotted',
]

export const WHITEBOARD_STROKE_SIZES: readonly WhiteboardStrokeSize[] = [
  's',
  'm',
  'l',
  'xl',
]

export function getWhiteboardElementStyle(
  element?: WhiteboardElement,
): WhiteboardElementStyle {
  const semantic = getSemanticStyle(element)
  return normalizeWhiteboardStyle({
    ...DEFAULT_WHITEBOARD_STYLE,
    ...semantic,
    ...element?.style,
  })
}

export function normalizeWhiteboardStyle(
  style: Partial<WhiteboardElementStyle> | undefined,
): WhiteboardElementStyle {
  return {
    strokeColor: isWhiteboardColorToken(style?.strokeColor)
      ? style.strokeColor
      : DEFAULT_WHITEBOARD_STYLE.strokeColor,
    fillColor: isWhiteboardColorToken(style?.fillColor)
      ? style.fillColor
      : DEFAULT_WHITEBOARD_STYLE.fillColor,
    opacity: clampOpacity(style?.opacity),
    fillStyle: isWhiteboardFillStyle(style?.fillStyle)
      ? style.fillStyle
      : DEFAULT_WHITEBOARD_STYLE.fillStyle,
    dashStyle: isWhiteboardDashStyle(style?.dashStyle)
      ? style.dashStyle
      : DEFAULT_WHITEBOARD_STYLE.dashStyle,
    strokeSize: isWhiteboardStrokeSize(style?.strokeSize)
      ? style.strokeSize
      : DEFAULT_WHITEBOARD_STYLE.strokeSize,
  }
}

export function resolveWhiteboardColor(
  token: WhiteboardColorToken,
  role: 'stroke' | 'fill',
) {
  if (role === 'fill') {
    switch (token) {
      case 'ink': return 'hsl(var(--foreground) / 0.12)'
      case 'gray': return 'hsl(var(--tint-gray))'
      case 'purple': return 'hsl(var(--tint-lavender))'
      case 'green': return 'hsl(var(--tint-mint))'
      case 'orange': return 'hsl(var(--tint-peach))'
      case 'red': return 'hsl(var(--tint-rose))'
      case 'yellow': return 'hsl(var(--tint-yellow))'
      case 'blue': return 'hsl(var(--tint-sky))'
      case 'white': return 'hsl(var(--background))'
    }
  }
  switch (token) {
    case 'ink': return 'hsl(var(--foreground))'
    case 'gray': return 'hsl(var(--muted-foreground))'
    case 'purple': return 'hsl(var(--brand))'
    case 'green': return 'hsl(var(--success))'
    case 'orange': return 'hsl(var(--warning))'
    case 'red': return 'hsl(var(--destructive))'
    case 'yellow': return 'hsl(var(--warning) / 0.72)'
    case 'blue': return 'hsl(var(--info))'
    case 'white': return 'hsl(var(--background))'
  }
}

export function getWhiteboardStrokeWidth(size: WhiteboardStrokeSize) {
  switch (size) {
    case 's': return 1.5
    case 'm': return 2.5
    case 'l': return 4
    case 'xl': return 7
  }
}

export function getWhiteboardDashArray(
  dash: WhiteboardDashStyle,
  strokeWidth: number,
) {
  switch (dash) {
    case 'solid': return undefined
    case 'dashed': return `${strokeWidth * 3.2} ${strokeWidth * 2.2}`
    case 'dotted': return `${strokeWidth * 0.25} ${strokeWidth * 2}`
  }
}

function getSemanticStyle(
  element: WhiteboardElement | undefined,
): Partial<WhiteboardElementStyle> {
  return element ? getBoardElementSemanticStyle(element) : {}
}

function clampOpacity(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_WHITEBOARD_STYLE.opacity
  return Math.min(1, Math.max(0.05, value || 0))
}

export function isWhiteboardColorToken(value: unknown): value is WhiteboardColorToken {
  return WHITEBOARD_COLOR_TOKENS.includes(value as WhiteboardColorToken)
}

export function isWhiteboardFillStyle(value: unknown): value is WhiteboardFillStyle {
  return WHITEBOARD_FILL_STYLES.includes(value as WhiteboardFillStyle)
}

export function isWhiteboardDashStyle(value: unknown): value is WhiteboardDashStyle {
  return WHITEBOARD_DASH_STYLES.includes(value as WhiteboardDashStyle)
}

export function isWhiteboardStrokeSize(value: unknown): value is WhiteboardStrokeSize {
  return WHITEBOARD_STROKE_SIZES.includes(value as WhiteboardStrokeSize)
}
