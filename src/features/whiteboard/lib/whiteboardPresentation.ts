import type {
  PresentationAsset,
  PresentationBounds,
  PresentationColor,
  PresentationDocument,
  PresentationElement,
  PresentationFill,
  PresentationLine,
  PresentationSlide,
  PresentationTextBody,
  PresentationWarning,
} from '@/features/presentation/lib/presentationTypes'
import {
  PRESENTATION_DOCUMENT_TYPE,
  PRESENTATION_DOCUMENT_VERSION,
  PRESENTATION_WIDE_SIZE,
} from '@/features/presentation/lib/presentationTypes'

import { getBoardElementUnrotatedBounds } from './boardElementDefinitions'
import {
  boardElementFromRecord,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardPageRecord,
  type BoardRecord,
} from './boardRecords'
import { isBoardFrameElement } from './boardHierarchy'
import { getWhiteboardContentBounds, getWhiteboardElementCenter } from './whiteboardGeometry'
import {
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
} from './whiteboardStyle'
import type {
  WhiteboardBounds,
  WhiteboardColorToken,
  WhiteboardElement,
  WhiteboardShapeType,
} from './whiteboardTypes'

const EMU_PER_PIXEL = 9_525
const DEFAULT_PAGE_PADDING = 32

const STROKE_COLORS: Record<WhiteboardColorToken, string> = {
  ink: '1A1A1A',
  gray: '787671',
  purple: '5645D4',
  green: '1AAE39',
  orange: 'DD5B00',
  red: 'E03131',
  yellow: 'C69200',
  blue: '0075DE',
  white: 'FFFFFF',
}

const FILL_COLORS: Record<WhiteboardColorToken, string> = {
  ink: 'E8E8E8',
  gray: 'F0EEEC',
  purple: 'E6E0F5',
  green: 'D9F3E1',
  orange: 'FFE8D4',
  red: 'FDE0EC',
  yellow: 'FEF7D6',
  blue: 'DCECFA',
  white: 'FFFFFF',
}

const PRESET_GEOMETRIES: Record<WhiteboardShapeType, string> = {
  rectangle: 'rect',
  ellipse: 'ellipse',
  triangle: 'triangle',
  diamond: 'diamond',
  hexagon: 'hexagon',
  pill: 'roundRect',
  parallelogram: 'parallelogram',
  star: 'star5',
  cloud: 'cloud',
  heart: 'heart',
  'x-box': 'rect',
  'check-box': 'rect',
  check: 'checkMark',
  'arrow-left': 'leftArrow',
  'arrow-right': 'rightArrow',
  'arrow-up': 'upArrow',
  'arrow-down': 'downArrow',
  line: 'line',
  frame: 'rect',
}

export type WhiteboardPresentationResult = {
  document: PresentationDocument
  warnings: PresentationWarning[]
}

export function createPresentationFromBoard(input: {
  title: string
  records: readonly BoardRecord[]
  slideSize?: { width: number; height: number }
  pagePadding?: number
  unframedContent?: 'append_slide' | 'omit'
}): WhiteboardPresentationResult {
  const warnings: PresentationWarning[] = []
  const slideSize = normalizeSlideSize(input.slideSize)
  const pages = input.records.filter(
    (record): record is BoardPageRecord => record.record_type === 'page',
  )
  const elements = input.records.filter(
    (record): record is BoardElementRecord => record.record_type === 'element',
  )
  const bindings = input.records.filter(
    (record): record is BoardBindingRecord => record.record_type === 'binding',
  )
  const assets = new Map<string, PresentationAsset>()
  const slides: PresentationSlide[] = []
  const orderedPages = pages.length > 0
    ? pages
    : [{ record_type: 'page', id: 'page:main', name: input.title, index: 0 } as BoardPageRecord]

  for (const page of orderedPages) {
    const pageRecords = elements
      .filter((record) => record.page_id === page.id)
      .sort((left, right) => left.index - right.index)
    appendPageSlides({
      assets,
      bindings,
      page,
      pagePadding: Math.max(0, input.pagePadding ?? DEFAULT_PAGE_PADDING),
      records: pageRecords,
      slideSize,
      slides,
      unframedContent: input.unframedContent ?? 'append_slide',
      warnings,
    })
  }

  if (slides.length === 0) {
    slides.push({
      id: 'slide:1',
      name: input.title || 'Untitled presentation',
      index: 0,
      background: solidFill('FFFFFF'),
      elements: [],
    })
  }

  return {
    document: {
      type: PRESENTATION_DOCUMENT_TYPE,
      schema_version: PRESENTATION_DOCUMENT_VERSION,
      title: input.title || 'Untitled presentation',
      slide_size: slideSize,
      theme: {
        name: 'Kition',
        major_font: 'Inter',
        minor_font: 'Inter',
        colors: {
          dk1: solidColor('1A1A1A'),
          lt1: solidColor('FFFFFF'),
          accent1: solidColor('5645D4'),
          accent2: solidColor('1AAE39'),
          accent3: solidColor('DD5B00'),
          accent4: solidColor('0075DE'),
          accent5: solidColor('E03131'),
          accent6: solidColor('C69200'),
        },
      },
      slides: slides.map((slide, index) => ({ ...slide, index })),
      assets: [...assets.values()],
      source: { format: 'kition_board' },
    },
    warnings,
  }
}

function appendPageSlides(input: {
  assets: Map<string, PresentationAsset>
  bindings: readonly BoardBindingRecord[]
  page: BoardPageRecord
  pagePadding: number
  records: readonly BoardElementRecord[]
  slideSize: { width: number; height: number }
  slides: PresentationSlide[]
  unframedContent: 'append_slide' | 'omit'
  warnings: PresentationWarning[]
}) {
  const elements = input.records.map(boardElementFromRecord)
  const byId = new Map(elements.map((element) => [element.id, element]))
  const frames = input.records.filter((record) => isBoardFrameElement(boardElementFromRecord(record)))

  if (frames.length === 0) {
    appendSlide({
      ...input,
      name: input.page.name,
      records: input.records,
      region: contentRegion(elements, input.pagePadding),
      slideId: `slide:${input.page.id}`,
    })
    return
  }

  const assignment = new Map<string, string>()
  for (const record of input.records) {
    const element = boardElementFromRecord(record)
    if (isBoardFrameElement(element)) continue
    const explicitFrame = findAncestorFrame(element, byId)
    const containingFrame = explicitFrame || smallestContainingFrame(element, frames)
    if (containingFrame) assignment.set(element.id, containingFrame.id)
  }

  for (const [frameIndex, frameRecord] of frames.entries()) {
    const frame = boardElementFromRecord(frameRecord)
    if (!isBoardFrameElement(frame)) continue
    const frameRecords = input.records.filter((record) => assignment.get(record.id) === frame.id)
    appendSlide({
      ...input,
      name: frame.text?.trim() || `${input.page.name} ${frameIndex + 1}`,
      records: frameRecords,
      region: getBoardElementUnrotatedBounds(frame),
      slideId: `slide:${frame.id}`,
    })
  }

  const unframed = input.records.filter((record) => {
    const element = boardElementFromRecord(record)
    return !isBoardFrameElement(element) && !assignment.has(element.id)
  })
  if (unframed.length === 0) return
  if (input.unframedContent === 'omit') {
    input.warnings.push({
      code: 'unframed_content_omitted',
      message: `${unframed.length} unframed whiteboard element(s) were not included in the presentation.`,
      severity: 'warning',
    })
    return
  }
  input.warnings.push({
    code: 'unframed_content_appended',
    message: `${unframed.length} unframed whiteboard element(s) were added as a separate slide.`,
    severity: 'info',
  })
  appendSlide({
    ...input,
    name: `${input.page.name} — Unframed`,
    records: unframed,
    region: contentRegion(unframed.map(boardElementFromRecord), input.pagePadding),
    slideId: `slide:${input.page.id}:unframed`,
  })
}

function appendSlide(input: {
  assets: Map<string, PresentationAsset>
  bindings: readonly BoardBindingRecord[]
  name: string
  records: readonly BoardElementRecord[]
  region: WhiteboardBounds
  slideId: string
  slideSize: { width: number; height: number }
  slides: PresentationSlide[]
  warnings: PresentationWarning[]
}) {
  const transform = createSlideTransform(input.region, input.slideSize)
  const exportedIds = new Set(input.records.map((record) => record.id))
  const parentById = new Map(input.records.map((record) => [record.id, record.parentId]))
  const elements = input.records
    .map((record) => convertElement({
      assets: input.assets,
      bindings: input.bindings,
      exportedIds,
      parentById,
      record,
      slideId: input.slideId,
      transform,
      warnings: input.warnings,
    }))
    .filter((element): element is PresentationElement => Boolean(element))
    .sort((left, right) => left.z_index - right.z_index)

  input.slides.push({
    id: input.slideId,
    name: input.name,
    index: input.slides.length,
    background: solidFill('FFFFFF'),
    elements,
  })
}

function convertElement(input: {
  assets: Map<string, PresentationAsset>
  bindings: readonly BoardBindingRecord[]
  exportedIds: ReadonlySet<string>
  parentById: ReadonlyMap<string, string | undefined>
  record: BoardElementRecord
  slideId: string
  transform: SlideTransform
  warnings: PresentationWarning[]
}): PresentationElement | null {
  const element = boardElementFromRecord(input.record)
  const bounds = input.transform.bounds(getBoardElementUnrotatedBounds(element))
  const common = {
    id: element.id,
    name: elementName(element),
    z_index: input.record.index,
    bounds,
    rotation: element.rotation || undefined,
    parent_id: element.parentId && input.exportedIds.has(element.parentId)
      ? element.parentId
      : undefined,
    source_id: element.id,
  }
  const style = getWhiteboardElementStyle(element)
  const line = presentationLine(style)

  switch (element.kind) {
    case 'rectangle': {
      const isFrame = element.shapeStyle === 'frame' || element.shapeType === 'frame'
      if (isFrame) return null
      if (element.shapeStyle === 'group') {
        return {
          ...common,
          kind: 'group',
          child_ids: [...input.exportedIds]
            .filter((id) => input.parentById.get(id) === element.id),
        }
      }
      const shapeType = element.shapeType || 'rectangle'
      let text = element.text
      if (shapeType === 'x-box' && !text) text = '×'
      if (shapeType === 'check-box' && !text) text = '✓'
      const fill = presentationFill(style)
      if (fill.kind === 'pattern') {
        input.warnings.push({
          code: 'pattern_fill_may_degrade',
          message: 'Pattern fills are retained semantically but may be simplified by PPTX renderers.',
          severity: 'info',
          slide_id: input.slideId,
          element_id: element.id,
        })
      }
      return {
        ...common,
        kind: 'shape',
        geometry: PRESET_GEOMETRIES[shapeType],
        fill,
        line,
        text: text ? centeredText(text, style.strokeColor, 15) : undefined,
      }
    }
    case 'text':
      return {
        ...common,
        kind: 'text',
        text: plainText(element.text, style.strokeColor, (element.fontSize ?? 22) * 0.75),
      }
    case 'image': {
      const assetId = `asset:${element.id}`
      if (!input.assets.has(assetId)) {
        input.assets.set(assetId, {
          id: assetId,
          kind: inferAssetKind(element.workspacePath),
          name: element.alt || element.workspacePath.split('/').pop(),
          mime_type: inferImageMime(element.workspacePath),
          source: { kind: 'workspace', workspace_path: element.workspacePath },
          width: bounds.width,
          height: bounds.height,
        })
      }
      return { ...common, kind: 'image', asset_id: assetId }
    }
    case 'connector': {
      const start = input.transform.point(element.start)
      const end = input.transform.point(element.end)
      const terminalBindings = input.bindings.filter((binding) => binding.from_id === element.id)
      return {
        ...common,
        kind: 'connector',
        bounds: boundsForPresentationPoints([start, end]),
        start,
        end,
        connector_type: 'straight',
        line: { ...line, end_arrow: line.end_arrow || 'triangle' },
        start_binding: presentationBinding(terminalBindings, 'start', input.exportedIds),
        end_binding: presentationBinding(terminalBindings, 'end', input.exportedIds),
      }
    }
    case 'stroke':
      return {
        ...common,
        kind: 'freeform',
        points: element.points.map(input.transform.point),
        closed: false,
        fill: { kind: 'none' },
        line,
      }
  }
}

function presentationBinding(
  bindings: readonly BoardBindingRecord[],
  terminal: 'start' | 'end',
  exportedIds: ReadonlySet<string>,
) {
  const binding = bindings.find((candidate) => candidate.terminal === terminal)
    || (terminal === 'end' ? bindings.find((candidate) => !candidate.terminal) : undefined)
  return binding && exportedIds.has(binding.to_id)
    ? { element_id: binding.to_id }
    : undefined
}

function presentationFill(style: ReturnType<typeof getWhiteboardElementStyle>): PresentationFill {
  if (style.fillStyle === 'none') return { kind: 'none' }
  if (style.fillStyle === 'pattern') return { kind: 'pattern', raw_kind: 'kition_diagonal' }
  return solidFill(FILL_COLORS[style.fillColor], style.opacity * (style.fillStyle === 'semi' ? 0.48 : 1))
}

function presentationLine(style: ReturnType<typeof getWhiteboardElementStyle>): PresentationLine {
  return {
    width: Math.max(1, Math.round(getWhiteboardStrokeWidth(style.strokeSize) * EMU_PER_PIXEL)),
    fill: solidFill(STROKE_COLORS[style.strokeColor], style.opacity),
    dash: style.dashStyle === 'dashed'
      ? 'dash'
      : style.dashStyle === 'dotted' ? 'dot' : 'solid',
    cap: 'round',
    join: 'round',
  }
}

function plainText(
  text: string,
  color: WhiteboardColorToken,
  sizePoints: number,
): PresentationTextBody {
  return {
    paragraphs: [{
      runs: [{
        text,
        font: {
          family: 'Inter',
          size_points: Math.max(6, sizePoints),
          color: solidColor(STROKE_COLORS[color]),
        },
      }],
      alignment: 'left',
    }],
    vertical_alignment: 'top',
    wrap: true,
    auto_fit: 'shrink_text',
  }
}

function centeredText(
  text: string,
  color: WhiteboardColorToken,
  sizePoints: number,
): PresentationTextBody {
  const body = plainText(text, color, sizePoints)
  body.paragraphs[0].alignment = 'center'
  body.vertical_alignment = 'middle'
  return body
}

function solidColor(value: string, alpha?: number): PresentationColor {
  return {
    kind: 'srgb',
    value,
    alpha: alpha != null && alpha < 1 ? clamp(alpha, 0, 1) : undefined,
  }
}

function solidFill(value: string, alpha?: number): PresentationFill {
  return { kind: 'solid', color: solidColor(value, alpha) }
}

function contentRegion(elements: readonly WhiteboardElement[], padding: number): WhiteboardBounds {
  const bounds = getWhiteboardContentBounds(elements)
  if (!bounds) return { x: 0, y: 0, width: 1280, height: 720 }
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
  }
}

function findAncestorFrame(
  element: WhiteboardElement,
  byId: ReadonlyMap<string, WhiteboardElement>,
) {
  let parentId = element.parentId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (isBoardFrameElement(parent)) return parent
    parentId = parent?.parentId
  }
  return undefined
}

function smallestContainingFrame(
  element: WhiteboardElement,
  frames: readonly BoardElementRecord[],
) {
  const center = getWhiteboardElementCenter(element)
  return frames
    .map(boardElementFromRecord)
    .filter(isBoardFrameElement)
    .map((frame) => ({ frame, bounds: getBoardElementUnrotatedBounds(frame) }))
    .filter(({ bounds }) => containsPoint(bounds, center))
    .sort((left, right) => area(left.bounds) - area(right.bounds))[0]?.frame
}

function containsPoint(bounds: WhiteboardBounds, point: { x: number; y: number }) {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height
}

function area(bounds: WhiteboardBounds) {
  return bounds.width * bounds.height
}

type SlideTransform = {
  point: (point: { x: number; y: number }) => { x: number; y: number }
  bounds: (bounds: WhiteboardBounds) => PresentationBounds
}

function createSlideTransform(
  region: WhiteboardBounds,
  slideSize: { width: number; height: number },
): SlideTransform {
  const width = Math.max(1, region.width)
  const height = Math.max(1, region.height)
  const scale = Math.min(slideSize.width / width, slideSize.height / height)
  const offsetX = (slideSize.width - width * scale) / 2
  const offsetY = (slideSize.height - height * scale) / 2
  const point = (value: { x: number; y: number }) => ({
    x: Math.round(offsetX + (value.x - region.x) * scale),
    y: Math.round(offsetY + (value.y - region.y) * scale),
  })
  return {
    point,
    bounds(value) {
      const origin = point(value)
      return {
        ...origin,
        width: Math.max(1, Math.round(value.width * scale)),
        height: Math.max(1, Math.round(value.height * scale)),
      }
    },
  }
}

function boundsForPresentationPoints(points: readonly { x: number; y: number }[]): PresentationBounds {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) - minX),
    height: Math.max(1, Math.max(...ys) - minY),
  }
}

function elementName(element: WhiteboardElement) {
  switch (element.kind) {
    case 'rectangle': return element.text?.trim() || element.shapeType || 'Shape'
    case 'text': return element.text.slice(0, 80) || 'Text'
    case 'image': return element.alt || element.workspacePath.split('/').pop() || 'Image'
    case 'connector': return 'Connector'
    case 'stroke': return 'Freeform'
  }
}

function inferAssetKind(path: string): PresentationAsset['kind'] {
  return path.toLowerCase().endsWith('.svg') ? 'svg' : 'image'
}

function inferImageMime(path: string) {
  const extension = path.toLowerCase().split('.').pop()
  switch (extension) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'avif': return 'image/avif'
    default: return 'image/png'
  }
}

function normalizeSlideSize(value?: { width: number; height: number }) {
  return {
    width: Math.max(1, Math.round(value?.width || PRESENTATION_WIDE_SIZE.width)),
    height: Math.max(1, Math.round(value?.height || PRESENTATION_WIDE_SIZE.height)),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
