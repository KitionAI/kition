import type { AgentWhiteboardElementKind } from '@/types/whiteboardAgent'

import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardRectangleElement,
  WhiteboardShapeType,
} from './whiteboardTypes'

export type BoardShapeDefinition = {
  shapeType: WhiteboardShapeType
  geometry: WhiteboardShapeType
  paletteOrder?: number
  defaultSize: { width: number; height: number }
  supportsFill: boolean
  supportsLabel: boolean
  defaultStyle?: Partial<WhiteboardElementStyle>
}

export type BoardElementDefinition = {
  kind: WhiteboardElement['kind']
  getUnrotatedBounds: (element: WhiteboardElement) => WhiteboardBounds
  getAgentKind: (element: WhiteboardElement) => AgentWhiteboardElementKind
  getSemanticStyle: (element: WhiteboardElement) => Partial<WhiteboardElementStyle>
}

const DEFAULT_SHAPE_SIZE = { width: 160, height: 100 } as const
const LINE_SHAPE_SIZE = { width: 160, height: 32 } as const
const EMPTY_BOUNDS: WhiteboardBounds = { x: 0, y: 0, width: 0, height: 0 }

const SHAPE_DEFINITIONS: readonly BoardShapeDefinition[] = [
  shapeDefinition('rectangle', 0),
  shapeDefinition('ellipse', 1),
  shapeDefinition('triangle', 2),
  shapeDefinition('diamond', 3),
  shapeDefinition('hexagon', 4),
  shapeDefinition('pill', 5),
  shapeDefinition('parallelogram', 6),
  shapeDefinition('star', 7),
  shapeDefinition('cloud', 8),
  shapeDefinition('heart', 9),
  shapeDefinition('x-box', 10),
  shapeDefinition('check-box', 11),
  shapeDefinition('arrow-left', 12),
  shapeDefinition('arrow-up', 13),
  shapeDefinition('arrow-down', 14),
  shapeDefinition('arrow-right', 15),
  shapeDefinition('line', 16, {
    defaultSize: LINE_SHAPE_SIZE,
    supportsFill: false,
    supportsLabel: false,
  }),
  shapeDefinition('frame', 17, {
    defaultStyle: { fillStyle: 'none', dashStyle: 'dashed' },
    supportsFill: false,
  }),
  shapeDefinition('check', undefined, {
    supportsFill: false,
    supportsLabel: false,
  }),
]

const SHAPE_DEFINITION_BY_TYPE = new Map(
  SHAPE_DEFINITIONS.map((definition) => [definition.shapeType, definition]),
)

export const WHITEBOARD_PALETTE_SHAPE_TYPES: readonly WhiteboardShapeType[] = [
  ...SHAPE_DEFINITIONS
    .filter((definition) => definition.paletteOrder != null)
    .sort((left, right) => left.paletteOrder! - right.paletteOrder!)
    .map((definition) => definition.shapeType),
]

const ELEMENT_DEFINITIONS: Record<WhiteboardElement['kind'], BoardElementDefinition> = {
  rectangle: {
    kind: 'rectangle',
    getUnrotatedBounds: getBoxElementBounds,
    getAgentKind: resolveRectangleAgentKind,
    getSemanticStyle: resolveRectangleSemanticStyle,
  },
  text: {
    kind: 'text',
    getUnrotatedBounds(element) {
      if (element.kind !== 'text') return EMPTY_BOUNDS
      const fontSize = element.fontSize ?? 22
      return {
        x: element.x,
        y: element.y - fontSize,
        width: Math.max(72, Array.from(element.text).length * fontSize * 0.55),
        height: fontSize + 8,
      }
    },
    getAgentKind: () => 'text',
    getSemanticStyle: () => ({}),
  },
  stroke: {
    kind: 'stroke',
    getUnrotatedBounds(element) {
      return element.kind === 'stroke' ? boundsForPoints(element.points) : EMPTY_BOUNDS
    },
    getAgentKind: () => 'freehand',
    getSemanticStyle: () => ({}),
  },
  connector: {
    kind: 'connector',
    getUnrotatedBounds(element) {
      return element.kind === 'connector'
        ? boundsForPoints([element.start, element.end])
        : EMPTY_BOUNDS
    },
    getAgentKind: () => 'connector',
    getSemanticStyle: () => ({}),
  },
  image: {
    kind: 'image',
    getUnrotatedBounds: getBoxElementBounds,
    getAgentKind: () => 'image',
    getSemanticStyle: () => ({}),
  },
}

export function getBoardShapeDefinition(
  shapeType: WhiteboardShapeType | undefined,
): BoardShapeDefinition {
  return SHAPE_DEFINITION_BY_TYPE.get(shapeType || 'rectangle')
    || SHAPE_DEFINITION_BY_TYPE.get('rectangle')!
}

export function getBoardElementDefinition(
  element: WhiteboardElement,
): BoardElementDefinition {
  return ELEMENT_DEFINITIONS[element.kind]
}

export function getBoardElementUnrotatedBounds(
  element: WhiteboardElement,
): WhiteboardBounds {
  return getBoardElementDefinition(element).getUnrotatedBounds(element)
}

export function getBoardAgentElementKind(
  element: WhiteboardElement,
): AgentWhiteboardElementKind {
  return getBoardElementDefinition(element).getAgentKind(element)
}

export function getBoardElementSemanticStyle(
  element: WhiteboardElement,
): Partial<WhiteboardElementStyle> {
  return getBoardElementDefinition(element).getSemanticStyle(element)
}

export function getBoardRectangleDefaultSize(input: {
  shapeStyle?: WhiteboardRectangleElement['shapeStyle']
  shapeType?: WhiteboardShapeType
}) {
  if (input.shapeStyle === 'sticky') return { width: 180, height: 140 }
  return { ...getBoardShapeDefinition(input.shapeType).defaultSize }
}

function shapeDefinition(
  shapeType: WhiteboardShapeType,
  paletteOrder?: number,
  options: Partial<Omit<BoardShapeDefinition, 'shapeType' | 'geometry' | 'paletteOrder'>> = {},
): BoardShapeDefinition {
  return {
    shapeType,
    geometry: shapeType,
    paletteOrder,
    defaultSize: { ...DEFAULT_SHAPE_SIZE },
    supportsFill: true,
    supportsLabel: true,
    ...options,
  }
}

function getBoxElementBounds(element: WhiteboardElement): WhiteboardBounds {
  if (element.kind !== 'rectangle' && element.kind !== 'image') return EMPTY_BOUNDS
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  }
}

function resolveRectangleAgentKind(
  element: WhiteboardElement,
): AgentWhiteboardElementKind {
  if (element.kind !== 'rectangle') return 'shape'
  switch (element.shapeStyle) {
    case 'sticky': return 'sticky'
    case 'mind-node': return 'mind_node'
    case 'flow-node': return 'flow_node'
    case 'frame': return 'frame'
    case 'group': return 'group'
    case 'image-placeholder': return 'image'
    default:
      return element.shapeType === 'frame' ? 'frame' : 'shape'
  }
}

function resolveRectangleSemanticStyle(
  element: WhiteboardElement,
): Partial<WhiteboardElementStyle> {
  if (element.kind !== 'rectangle') return {}
  const shapeStyle = getBoardShapeDefinition(element.shapeType).defaultStyle || {}
  switch (element.shapeStyle) {
    case 'sticky': return { ...shapeStyle, fillColor: 'yellow' }
    case 'mind-node': return { ...shapeStyle, fillColor: 'purple' }
    case 'image-placeholder': return { ...shapeStyle, fillColor: 'blue' }
    case 'frame':
    case 'group':
      return { ...shapeStyle, fillStyle: 'none', dashStyle: 'dashed' }
    default: return shapeStyle
  }
}

function boundsForPoints(points: readonly { x: number; y: number }[]): WhiteboardBounds {
  if (!points.length) return EMPTY_BOUNDS
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}
