export const PRESENTATION_OOXML_CAPABILITY = 'presentation_ooxml_v1' as const
export const PRESENTATION_DOCUMENT_TYPE = 'presentation.document' as const
export const PRESENTATION_DOCUMENT_VERSION = 1 as const
export const PRESENTATION_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const

export const PRESENTATION_WIDE_SIZE = {
  width: 12_192_000,
  height: 6_858_000,
} as const

export type PresentationPoint = {
  x: number
  y: number
}

export type PresentationBounds = PresentationPoint & {
  width: number
  height: number
}

export type PresentationColor =
  | {
      kind: 'srgb'
      value: string
      alpha?: number
    }
  | {
      kind: 'scheme'
      value:
        | 'dk1'
        | 'lt1'
        | 'dk2'
        | 'lt2'
        | 'accent1'
        | 'accent2'
        | 'accent3'
        | 'accent4'
        | 'accent5'
        | 'accent6'
        | 'hlink'
        | 'folHlink'
        | 'tx1'
        | 'tx2'
        | 'bg1'
        | 'bg2'
        | 'phClr'
      alpha?: number
      tint?: number
      shade?: number
    }

export type PresentationFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: PresentationColor }
  | { kind: 'gradient'; raw_kind?: string }
  | { kind: 'pattern'; raw_kind?: string }
  | { kind: 'image'; asset_id: string }

export type PresentationLine = {
  width: number
  fill: PresentationFill
  dash: 'solid' | 'dash' | 'dot' | 'dash_dot' | 'long_dash' | 'custom'
  cap?: 'flat' | 'round' | 'square'
  join?: 'round' | 'bevel' | 'miter'
  start_arrow?: string
  end_arrow?: string
}

export type PresentationFont = {
  family?: string
  size_points?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: PresentationColor
  language?: string
}

export type PresentationTextRun = {
  text: string
  font?: PresentationFont
  hyperlink?: string
}

export type PresentationBullet = {
  kind: 'none' | 'character' | 'number'
  character?: string
  number_style?: string
  start_at?: number
}

export type PresentationParagraph = {
  runs: PresentationTextRun[]
  alignment?: 'left' | 'center' | 'right' | 'justify' | 'distributed'
  level?: number
  bullet?: PresentationBullet
  margin_left?: number
  indent?: number
  space_before_points?: number
  space_after_points?: number
  line_spacing_points?: number
}

export type PresentationTextBody = {
  paragraphs: PresentationParagraph[]
  vertical_alignment?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  auto_fit?: 'none' | 'shrink_text' | 'resize_shape'
  margin_left?: number
  margin_right?: number
  margin_top?: number
  margin_bottom?: number
}

export type PresentationBinding = {
  element_id: string
  site_index?: number
}

type PresentationElementBase = {
  id: string
  name?: string
  z_index: number
  bounds: PresentationBounds
  rotation?: number
  flip_horizontal?: boolean
  flip_vertical?: boolean
  parent_id?: string
  source_id?: string
}

export type PresentationShapeElement = PresentationElementBase & {
  kind: 'shape'
  geometry: string
  fill?: PresentationFill
  line?: PresentationLine
  text?: PresentationTextBody
}

export type PresentationTextElement = PresentationElementBase & {
  kind: 'text'
  text: PresentationTextBody
  fill?: PresentationFill
  line?: PresentationLine
}

export type PresentationImageElement = PresentationElementBase & {
  kind: 'image'
  asset_id: string
  crop?: {
    left: number
    top: number
    right: number
    bottom: number
  }
}

export type PresentationConnectorElement = PresentationElementBase & {
  kind: 'connector'
  start: PresentationPoint
  end: PresentationPoint
  connector_type: 'straight' | 'elbow' | 'curved'
  line?: PresentationLine
  start_binding?: PresentationBinding
  end_binding?: PresentationBinding
}

export type PresentationFreeformElement = PresentationElementBase & {
  kind: 'freeform'
  points: Array<PresentationPoint & { pressure?: number }>
  closed?: boolean
  fill?: PresentationFill
  line?: PresentationLine
  text?: PresentationTextBody
}

export type PresentationGroupElement = PresentationElementBase & {
  kind: 'group'
  child_ids: string[]
}

export type PresentationTableCell = {
  row: number
  column: number
  row_span?: number
  column_span?: number
  text: PresentationTextBody
  fill?: PresentationFill
}

export type PresentationTableElement = PresentationElementBase & {
  kind: 'table'
  table: {
    rows: number
    columns: number
    row_heights?: number[]
    column_widths?: number[]
    cells: PresentationTableCell[]
  }
}

export type PresentationChartElement = PresentationElementBase & {
  kind: 'chart'
  chart: {
    chart_type: string
    title?: string
    category_count?: number
    series_count?: number
    source_part?: string
  }
}

export type PresentationMediaElement = PresentationElementBase & {
  kind: 'media'
  asset_id: string
}

export type PresentationUnsupportedElement = PresentationElementBase & {
  kind: 'unsupported'
  source_part?: string
  source_kind: string
  fallback_asset_id?: string
  preserve_key?: string
}

export type PresentationElement =
  | PresentationShapeElement
  | PresentationTextElement
  | PresentationImageElement
  | PresentationConnectorElement
  | PresentationFreeformElement
  | PresentationGroupElement
  | PresentationTableElement
  | PresentationChartElement
  | PresentationMediaElement
  | PresentationUnsupportedElement

export type PresentationAssetSource =
  | { kind: 'workspace'; workspace_path: string }
  | { kind: 'package'; part_name: string }
  | { kind: 'external'; url: string }

export type PresentationAsset = {
  id: string
  kind: 'image' | 'audio' | 'video' | 'svg' | 'binary'
  name?: string
  mime_type: string
  source: PresentationAssetSource
  width?: number
  height?: number
  sha256?: string
}

export type PresentationSlide = {
  id: string
  name: string
  index: number
  master_name?: string
  layout_name?: string
  background?: PresentationFill
  elements: PresentationElement[]
  notes?: PresentationTextBody
}

export type PresentationDocument = {
  type: typeof PRESENTATION_DOCUMENT_TYPE
  schema_version: typeof PRESENTATION_DOCUMENT_VERSION
  title: string
  slide_size: {
    width: number
    height: number
  }
  theme?: {
    name?: string
    colors?: Record<string, PresentationColor>
    major_font?: string
    minor_font?: string
  }
  slides: PresentationSlide[]
  assets: PresentationAsset[]
  source?: {
    format: 'kition_board' | 'pptx' | 'generated'
    workspace_path?: string
    application?: string
  }
}

export type PresentationWarning = {
  code: string
  message: string
  severity: 'info' | 'warning' | 'error'
  slide_id?: string
  element_id?: string
}

export type PresentationInspectRequest = {
  workspace_path: string
  include_notes?: boolean
  include_unsupported?: boolean
}

export type PresentationInspectResponse = {
  document: PresentationDocument
  warnings: PresentationWarning[]
}

export type PresentationRenderRequest = {
  document: PresentationDocument
  target_path: string
  source_pptx_path?: string
  unsupported_policy?: 'preserve' | 'rasterize' | 'omit'
  overwrite?: boolean
}

export type PresentationRenderResponse = {
  path: string
  mime_type: typeof PRESENTATION_MIME_TYPE
  slide_count: number
  warnings: PresentationWarning[]
}

export function runtimeSupportsPresentationOOXML(capabilities?: readonly string[]) {
  return Boolean(capabilities?.includes(PRESENTATION_OOXML_CAPABILITY))
}
