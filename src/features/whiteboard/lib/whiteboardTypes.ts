export type WhiteboardPoint = {
  x: number
  y: number
}

export type WhiteboardBounds = WhiteboardPoint & {
  width: number
  height: number
}

export type WhiteboardViewport = WhiteboardPoint & {
  zoom: number
}

export type WhiteboardTool =
  | 'select'
  | 'hand'
  | 'eraser'
  | 'rectangle'
  | 'note'
  | 'text'
  | 'pen'
  | 'highlight'
  | 'connector'

export type WhiteboardShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'hexagon'
  | 'pill'
  | 'parallelogram'
  | 'star'
  | 'cloud'
  | 'heart'
  | 'x-box'
  | 'check-box'
  | 'check'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'line'
  | 'frame'

export type WhiteboardColorToken =
  | 'ink'
  | 'gray'
  | 'purple'
  | 'green'
  | 'orange'
  | 'red'
  | 'yellow'
  | 'blue'
  | 'white'

export type WhiteboardFillStyle = 'none' | 'solid' | 'semi' | 'pattern'
export type WhiteboardDashStyle = 'solid' | 'dashed' | 'dotted'
export type WhiteboardStrokeSize = 's' | 'm' | 'l' | 'xl'

export type WhiteboardElementStyle = {
  strokeColor: WhiteboardColorToken
  fillColor: WhiteboardColorToken
  opacity: number
  fillStyle: WhiteboardFillStyle
  dashStyle: WhiteboardDashStyle
  strokeSize: WhiteboardStrokeSize
}

type WhiteboardElementBase = {
  id: string
  locked?: boolean
  parentId?: string
  rotation?: number
  sourceRefIds?: string[]
  style?: Partial<WhiteboardElementStyle>
}

export type WhiteboardRectangleStyle =
  | 'default'
  | 'sticky'
  | 'mind-node'
  | 'flow-node'
  | 'frame'
  | 'group'
  | 'image-placeholder'

export type WhiteboardRectangleElement = WhiteboardElementBase & {
  kind: 'rectangle'
  x: number
  y: number
  width: number
  height: number
  shapeType?: WhiteboardShapeType
  shapeStyle?: WhiteboardRectangleStyle
  text?: string
}

export type WhiteboardTextElement = WhiteboardElementBase & {
  kind: 'text'
  x: number
  y: number
  text: string
  fontSize?: number
}

export type WhiteboardResizeHandle =
  | 'north-west'
  | 'north'
  | 'north-east'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'

export type WhiteboardStrokeElement = WhiteboardElementBase & {
  kind: 'stroke'
  points: WhiteboardPoint[]
}

export type WhiteboardConnectorElement = WhiteboardElementBase & {
  kind: 'connector'
  start: WhiteboardPoint
  end: WhiteboardPoint
}

export type WhiteboardImageElement = WhiteboardElementBase & {
  kind: 'image'
  x: number
  y: number
  width: number
  height: number
  workspacePath: string
  alt?: string
}

export type WhiteboardElement =
  | WhiteboardRectangleElement
  | WhiteboardTextElement
  | WhiteboardStrokeElement
  | WhiteboardConnectorElement
  | WhiteboardImageElement

export type WhiteboardDraft =
  | {
      kind: 'rectangle'
      start: WhiteboardPoint
      current: WhiteboardPoint
      shapeType?: WhiteboardShapeType
      shapeStyle?: WhiteboardRectangleStyle
      style?: Partial<WhiteboardElementStyle>
    }
  | {
      kind: 'stroke'
      points: WhiteboardPoint[]
      style?: Partial<WhiteboardElementStyle>
    }
  | {
      kind: 'connector'
      start: WhiteboardPoint
      current: WhiteboardPoint
      style?: Partial<WhiteboardElementStyle>
    }
  | {
      kind: 'selection'
      start: WhiteboardPoint
      current: WhiteboardPoint
    }

export type WhiteboardTextEditingState = {
  elementId: string
  elementKind: 'rectangle' | 'text'
  parentId?: string
  x: number
  y: number
  value: string
  isNew: boolean
}
