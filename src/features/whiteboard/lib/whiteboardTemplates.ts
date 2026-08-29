import { createBoardConnectorBindingRecord } from './boardBindingEngine'
import type { BoardBindingRecord } from './boardRecords'
import { createWhiteboardElementId } from './whiteboardElementId'
import type {
  WhiteboardColorToken,
  WhiteboardConnectorElement,
  WhiteboardConnectorType,
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardRectangleElement,
  WhiteboardShapeType,
} from './whiteboardTypes'

export const WHITEBOARD_TEMPLATE_IDS = [
  'mind-map',
  'flowchart',
  'project-roadmap',
  'kanban-board',
  'meeting-retrospective',
  'presentation-storyboard',
] as const

export type WhiteboardTemplateId = typeof WHITEBOARD_TEMPLATE_IDS[number]

export type WhiteboardTemplateCategory =
  | 'recommended'
  | 'planning'
  | 'meetings'
  | 'presentation'

export type WhiteboardTemplateDefinition = {
  categories: readonly WhiteboardTemplateCategory[]
  id: WhiteboardTemplateId
  height: number
  width: number
}

export type WhiteboardTemplateInstance = {
  bindings: BoardBindingRecord[]
  elements: WhiteboardElement[]
  rootIds: string[]
}

export type WhiteboardTemplateCreationSelection = {
  template: WhiteboardTemplateInstance
  templateId: WhiteboardTemplateId
  title: string
}

export const WHITEBOARD_TEMPLATES: readonly WhiteboardTemplateDefinition[] = [
  { id: 'mind-map', categories: ['recommended', 'planning'], width: 820, height: 360 },
  { id: 'flowchart', categories: ['recommended', 'planning'], width: 920, height: 520 },
  { id: 'project-roadmap', categories: ['planning'], width: 960, height: 560 },
  { id: 'kanban-board', categories: ['recommended', 'planning'], width: 960, height: 600 },
  { id: 'meeting-retrospective', categories: ['meetings'], width: 960, height: 580 },
  { id: 'presentation-storyboard', categories: ['presentation'], width: 1000, height: 650 },
]

export function instantiateWhiteboardTemplate(
  templateId: WhiteboardTemplateId,
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
): WhiteboardTemplateInstance {
  switch (templateId) {
    case 'mind-map': return createMindMapTemplate(origin, resolveText)
    case 'flowchart': return createFlowchartTemplate(origin, resolveText)
    case 'project-roadmap': return createProjectRoadmapTemplate(origin, resolveText)
    case 'kanban-board': return createKanbanTemplate(origin, resolveText)
    case 'meeting-retrospective': return createRetrospectiveTemplate(origin, resolveText)
    case 'presentation-storyboard': return createStoryboardTemplate(origin, resolveText)
  }
}

function createMindMapTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 820, 360, resolveText)
  const topicId = board.addNode('topic', 40, 144, 210, 72, 'mindMap.topic', {
    fillColor: 'gray',
    mindMapDirection: 'right',
    shapeStyle: 'mind-node',
    strokeColor: 'purple',
  })
  board.addNode('research', 355, 70, 142, 56, 'mindMap.research', {
    fillColor: 'white',
    shapeStyle: 'mind-node',
    strokeColor: 'purple',
  })
  board.addNode('ideas', 355, 230, 142, 56, 'mindMap.ideas', {
    fillColor: 'white',
    shapeStyle: 'mind-node',
    strokeColor: 'blue',
  })
  board.addNode('questions', 650, 72, 150, 52, 'mindMap.questions', {
    fillColor: 'white',
    shapeStyle: 'mind-node',
    strokeColor: 'purple',
  })
  board.connect('topic', 'research', 'east', 'west', {
    connectorRole: 'mind-map-branch', connectorType: 'straight', endArrowhead: 'none', strokeColor: 'purple',
  })
  board.connect('topic', 'ideas', 'east', 'west', {
    connectorRole: 'mind-map-branch', connectorType: 'straight', endArrowhead: 'none', strokeColor: 'blue',
  })
  board.connect('research', 'questions', 'east', 'west', {
    connectorRole: 'mind-map-branch', connectorType: 'straight', endArrowhead: 'none', strokeColor: 'purple',
  })
  return {
    ...board.finish({ includeRootFrame: false }),
    rootIds: [topicId],
  }
}

function createFlowchartTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 920, 520, resolveText)
  board.addTitle('flowchart.title')
  board.addNode('start', 40, 220, 130, 64, 'flowchart.start', {
    fillColor: 'green',
    shapeType: 'pill',
    strokeColor: 'green',
  })
  board.addNode('process', 220, 205, 180, 92, 'flowchart.process', {
    fillColor: 'blue',
    shapeStyle: 'flow-node',
    strokeColor: 'blue',
  })
  board.addNode('decision', 465, 190, 140, 120, 'flowchart.decision', {
    fillColor: 'yellow',
    shapeStyle: 'flow-node',
    shapeType: 'diamond',
    strokeColor: 'orange',
  })
  board.addNode('revise', 460, 370, 150, 72, 'flowchart.revise', {
    fillColor: 'red',
    shapeStyle: 'flow-node',
    strokeColor: 'red',
  })
  board.addNode('finish', 700, 220, 150, 64, 'flowchart.finish', {
    fillColor: 'purple',
    shapeType: 'pill',
    strokeColor: 'purple',
  })
  board.addText(628, 211, 'flowchart.yes', { fontSize: 15, strokeColor: 'green' })
  board.addText(548, 348, 'flowchart.no', { fontSize: 15, strokeColor: 'red' })
  board.connect('start', 'process', 'east', 'west', { connectorType: 'elbow' })
  board.connect('process', 'decision', 'east', 'west', { connectorType: 'elbow' })
  board.connect('decision', 'finish', 'east', 'west', { connectorType: 'elbow' })
  board.connect('decision', 'revise', 'south', 'north', { connectorType: 'elbow' })
  board.connect('revise', 'process', 'west', 'south', { connectorType: 'elbow' })
  return board.finish()
}

function createProjectRoadmapTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 960, 560, resolveText)
  board.addTitle('roadmap.title')
  const phases = [
    { key: 'discover', x: 45, color: 'blue' as const },
    { key: 'prototype', x: 275, color: 'purple' as const },
    { key: 'validate', x: 505, color: 'orange' as const },
    { key: 'launch', x: 735, color: 'green' as const },
  ]
  phases.forEach((phase, index) => {
    board.addText(phase.x, 118, `roadmap.quarter${index + 1}`, {
      fontSize: 16,
      strokeColor: phase.color,
    })
    board.addNode(phase.key, phase.x, 145, 180, 150, `roadmap.${phase.key}`, {
      fillColor: phase.color,
      strokeColor: phase.color,
    })
    board.addNode(`${phase.key}-milestone`, phase.x, 360, 180, 90, `roadmap.${phase.key}Milestone`, {
      fillColor: phase.color,
      shapeStyle: 'sticky',
      strokeColor: phase.color,
    })
    board.connect(
      phase.key,
      `${phase.key}-milestone`,
      'south',
      'north',
      { connectorType: 'straight', endArrowhead: 'dot' },
    )
  })
  board.connect('discover', 'prototype', 'east', 'west', { connectorType: 'straight' })
  board.connect('prototype', 'validate', 'east', 'west', { connectorType: 'straight' })
  board.connect('validate', 'launch', 'east', 'west', { connectorType: 'straight' })
  return board.finish()
}

function createKanbanTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 960, 600, resolveText)
  board.addTitle('kanban.title')
  const todo = board.addFrame(30, 82, 280, 480)
  const progress = board.addFrame(340, 82, 280, 480)
  const done = board.addFrame(650, 82, 280, 480)
  board.addText(50, 122, 'kanban.todo', { fontSize: 18, parentId: todo })
  board.addText(360, 122, 'kanban.progress', { fontSize: 18, parentId: progress })
  board.addText(670, 122, 'kanban.done', { fontSize: 18, parentId: done })
  board.addNode('scope', 50, 150, 240, 112, 'kanban.scope', {
    fillColor: 'yellow', parentId: todo, shapeStyle: 'sticky', strokeColor: 'orange',
  })
  board.addNode('content', 50, 284, 240, 112, 'kanban.content', {
    fillColor: 'blue', parentId: todo, shapeStyle: 'sticky', strokeColor: 'blue',
  })
  board.addNode('prototype', 360, 150, 240, 112, 'kanban.prototype', {
    fillColor: 'purple', parentId: progress, shapeStyle: 'sticky', strokeColor: 'purple',
  })
  board.addNode('testing', 360, 284, 240, 112, 'kanban.testing', {
    fillColor: 'orange', parentId: progress, shapeStyle: 'sticky', strokeColor: 'orange',
  })
  board.addNode('kickoff', 670, 150, 240, 112, 'kanban.kickoff', {
    fillColor: 'green', parentId: done, shapeStyle: 'sticky', strokeColor: 'green',
  })
  board.addNode('research', 670, 284, 240, 112, 'kanban.research', {
    fillColor: 'green', parentId: done, shapeStyle: 'sticky', strokeColor: 'green',
  })
  return board.finish()
}

function createRetrospectiveTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 960, 580, resolveText)
  board.addTitle('retrospective.title')
  const well = board.addFrame(30, 82, 280, 460)
  const improve = board.addFrame(340, 82, 280, 460)
  const next = board.addFrame(650, 82, 280, 460)
  board.addText(50, 122, 'retrospective.well', {
    fontSize: 18, parentId: well, strokeColor: 'green',
  })
  board.addText(360, 122, 'retrospective.improve', {
    fontSize: 18, parentId: improve, strokeColor: 'orange',
  })
  board.addText(670, 122, 'retrospective.next', {
    fontSize: 18, parentId: next, strokeColor: 'purple',
  })
  board.addNode('clear-goal', 50, 150, 240, 112, 'retrospective.clearGoal', {
    fillColor: 'green', parentId: well, shapeStyle: 'sticky', strokeColor: 'green',
  })
  board.addNode('feedback', 50, 284, 240, 112, 'retrospective.feedback', {
    fillColor: 'green', parentId: well, shapeStyle: 'sticky', strokeColor: 'green',
  })
  board.addNode('decisions', 360, 150, 240, 112, 'retrospective.decisions', {
    fillColor: 'orange', parentId: improve, shapeStyle: 'sticky', strokeColor: 'orange',
  })
  board.addNode('owners', 360, 284, 240, 112, 'retrospective.owners', {
    fillColor: 'red', parentId: improve, shapeStyle: 'sticky', strokeColor: 'red',
  })
  board.addNode('assign', 670, 150, 240, 112, 'retrospective.assign', {
    fillColor: 'purple', parentId: next, shapeStyle: 'sticky', strokeColor: 'purple',
  })
  board.addNode('review', 670, 284, 240, 112, 'retrospective.review', {
    fillColor: 'blue', parentId: next, shapeStyle: 'sticky', strokeColor: 'blue',
  })
  return board.finish()
}

function createStoryboardTemplate(
  origin: WhiteboardPoint,
  resolveText: (key: string) => string,
) {
  const board = createTemplateBuilder(origin, 1000, 650, resolveText)
  board.addTitle('storyboard.title')
  const slides = [
    { key: 'cover', x: 35, y: 85 },
    { key: 'problem', x: 355, y: 85 },
    { key: 'insight', x: 675, y: 85 },
    { key: 'solution', x: 35, y: 370 },
    { key: 'proof', x: 355, y: 370 },
    { key: 'nextStep', x: 675, y: 370 },
  ]
  slides.forEach((slide, index) => {
    const frame = board.addFrame(slide.x, slide.y, 290, 235)
    board.addText(slide.x + 18, slide.y + 34, `storyboard.${slide.key}`, {
      fontSize: 17,
      parentId: frame,
    })
    board.addText(slide.x + 250, slide.y + 34, `storyboard.slide${index + 1}`, {
      fontSize: 13,
      parentId: frame,
      strokeColor: 'gray',
    })
    board.addNode(`slide-${index + 1}`, slide.x + 18, slide.y + 55, 254, 150, 'storyboard.visual', {
      fillColor: index % 2 === 0 ? 'purple' : 'blue',
      parentId: frame,
      shapeStyle: 'image-placeholder',
      strokeColor: index % 2 === 0 ? 'purple' : 'blue',
    })
  })
  return board.finish()
}

type TemplateAnchor = 'north' | 'east' | 'south' | 'west'

type TemplateNodeOptions = {
  fillColor?: WhiteboardColorToken
  mindMapBranchSide?: WhiteboardRectangleElement['mindMapBranchSide']
  mindMapDirection?: WhiteboardRectangleElement['mindMapDirection']
  parentId?: string
  shapeStyle?: WhiteboardRectangleElement['shapeStyle']
  shapeType?: WhiteboardShapeType
  strokeColor?: WhiteboardColorToken
}

function createTemplateBuilder(
  origin: WhiteboardPoint,
  width: number,
  height: number,
  resolveText: (key: string) => string,
) {
  const offset = {
    x: origin.x - width / 2,
    y: origin.y - height / 2,
  }
  const rootId = createWhiteboardElementId('rectangle')
  const elements: WhiteboardElement[] = [{
    id: rootId,
    kind: 'rectangle',
    x: offset.x,
    y: offset.y,
    width,
    height,
    shapeStyle: 'frame',
    shapeType: 'frame',
    style: {
      dashStyle: 'solid',
      fillStyle: 'none',
      strokeColor: 'gray',
      strokeSize: 's',
    },
  }]
  const bindings: BoardBindingRecord[] = []
  const nodes = new Map<string, WhiteboardRectangleElement>()

  function addTitle(key: string) {
    return addText(24, 46, key, { fontSize: 24 })
  }

  function addFrame(x: number, y: number, frameWidth: number, frameHeight: number) {
    const id = createWhiteboardElementId('rectangle')
    elements.push({
      id,
      kind: 'rectangle',
      parentId: rootId,
      x: offset.x + x,
      y: offset.y + y,
      width: frameWidth,
      height: frameHeight,
      shapeStyle: 'frame',
      shapeType: 'frame',
      style: {
        dashStyle: 'solid',
        fillStyle: 'none',
        strokeColor: 'gray',
        strokeSize: 's',
      },
    })
    return id
  }

  function addNode(
    key: string,
    x: number,
    y: number,
    nodeWidth: number,
    nodeHeight: number,
    textKey: string,
    options: TemplateNodeOptions = {},
  ) {
    const element: WhiteboardRectangleElement = {
      id: createWhiteboardElementId('rectangle'),
      kind: 'rectangle',
      parentId: options.parentId || rootId,
      x: offset.x + x,
      y: offset.y + y,
      width: nodeWidth,
      height: nodeHeight,
      mindMapBranchSide: options.mindMapBranchSide,
      mindMapDirection: options.mindMapDirection,
      shapeStyle: options.shapeStyle,
      shapeType: options.shapeType || 'rectangle',
      text: resolveText(textKey),
      style: {
        dashStyle: 'solid',
        fillColor: options.fillColor || 'white',
        fillStyle: 'solid',
        strokeColor: options.strokeColor || 'ink',
        strokeSize: 's',
      },
    }
    nodes.set(key, element)
    elements.push(element)
    return element.id
  }

  function addText(
    x: number,
    y: number,
    textKey: string,
    options: {
      fontSize?: number
      parentId?: string
      strokeColor?: WhiteboardColorToken
    } = {},
  ) {
    const id = createWhiteboardElementId('text')
    elements.push({
      id,
      kind: 'text',
      parentId: options.parentId || rootId,
      x: offset.x + x,
      y: offset.y + y,
      text: resolveText(textKey),
      fontSize: options.fontSize || 16,
      style: {
        strokeColor: options.strokeColor || 'ink',
      },
    })
    return id
  }

  function connect(
    fromKey: string,
    toKey: string,
    fromAnchor: TemplateAnchor,
    toAnchor: TemplateAnchor,
    options: {
      connectorRole?: WhiteboardConnectorElement['connectorRole']
      connectorType?: WhiteboardConnectorType
      endArrowhead?: 'arrow' | 'dot' | 'none'
      strokeColor?: WhiteboardColorToken
    } = {},
  ) {
    const from = nodes.get(fromKey)
    const to = nodes.get(toKey)
    if (!from || !to) return
    const connectorId = createWhiteboardElementId('connector')
    const start = getAnchorPoint(from, fromAnchor)
    const end = getAnchorPoint(to, toAnchor)
    elements.push({
      id: connectorId,
      kind: 'connector',
      parentId: rootId,
      start,
      end,
      connectorRole: options.connectorRole,
      connectorType: options.connectorType || 'straight',
      endArrowhead: options.endArrowhead || 'arrow',
      style: {
        strokeColor: options.strokeColor || 'gray',
        strokeSize: 's',
      },
    })
    bindings.push(
      createBoardConnectorBindingRecord({
        connectorId,
        terminal: 'start',
        anchor: {
          point: start,
          targetElementId: from.id,
          targetAnchor: getNormalizedAnchor(fromAnchor),
        },
      }),
      createBoardConnectorBindingRecord({
        connectorId,
        terminal: 'end',
        anchor: {
          point: end,
          targetElementId: to.id,
          targetAnchor: getNormalizedAnchor(toAnchor),
        },
      }),
    )
  }

  function finish(options: { includeRootFrame?: boolean } = {}): WhiteboardTemplateInstance {
    const [root, ...children] = elements
    const orderedChildren = [
      ...children.filter((element) => element.kind === 'connector'),
      ...children.filter((element) => element.kind !== 'connector'),
    ]
    if (options.includeRootFrame === false) {
      const topLevelElements = orderedChildren.map((element) => (
        element.parentId === rootId ? { ...element, parentId: undefined } : element
      ))
      return {
        bindings,
        elements: topLevelElements,
        rootIds: topLevelElements.map((element) => element.id),
      }
    }
    return {
      bindings,
      elements: [root, ...orderedChildren],
      rootIds: [rootId],
    }
  }

  return {
    addFrame,
    addNode,
    addText,
    addTitle,
    connect,
    finish,
  }
}

function getAnchorPoint(
  element: WhiteboardRectangleElement,
  anchor: TemplateAnchor,
): WhiteboardPoint {
  const normalized = getNormalizedAnchor(anchor)
  return {
    x: element.x + element.width * normalized.x,
    y: element.y + element.height * normalized.y,
  }
}

function getNormalizedAnchor(anchor: TemplateAnchor): WhiteboardPoint {
  switch (anchor) {
    case 'north': return { x: 0.5, y: 0 }
    case 'east': return { x: 1, y: 0.5 }
    case 'south': return { x: 0.5, y: 1 }
    case 'west': return { x: 0, y: 0.5 }
  }
}
