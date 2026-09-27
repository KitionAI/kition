/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/presentation-ooxml.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type PresentationOoxmlIdentifier = string

export type PresentationOoxmlPortablePath = string

export type PresentationOoxmlEmu = number

export type PresentationOoxmlPositiveEmu = number

export type PresentationOoxmlPoint = {
  x: PresentationOoxmlEmu
  y: PresentationOoxmlEmu
}

export type PresentationOoxmlBounds = {
  x: PresentationOoxmlEmu
  y: PresentationOoxmlEmu
  width: PresentationOoxmlPositiveEmu
  height: PresentationOoxmlPositiveEmu
}

export type PresentationOoxmlColor = {
  kind: "srgb"
  value: string
  alpha?: number
} | {
  kind: "scheme"
  value: "dk1" | "lt1" | "dk2" | "lt2" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6" | "hlink" | "folHlink" | "tx1" | "tx2" | "bg1" | "bg2" | "phClr"
  alpha?: number
  tint?: number
  shade?: number
}

export type PresentationOoxmlFill = (unknown) & (unknown)

export type PresentationOoxmlLine = {
  width: PresentationOoxmlPositiveEmu
  fill: PresentationOoxmlFill
  dash: "solid" | "dash" | "dot" | "dash_dot" | "long_dash" | "custom"
  cap?: "flat" | "round" | "square"
  join?: "round" | "bevel" | "miter"
  start_arrow?: string
  end_arrow?: string
}

export type PresentationOoxmlFont = {
  family?: string
  size_points?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: PresentationOoxmlColor
  language?: string
}

export type PresentationOoxmlTextRun = {
  text: string
  font?: PresentationOoxmlFont
  hyperlink?: string
}

export type PresentationOoxmlBullet = {
  kind: "none" | "character" | "number"
  character?: string
  number_style?: string
  start_at?: number
}

export type PresentationOoxmlParagraph = {
  runs: PresentationOoxmlTextRun[]
  alignment?: "left" | "center" | "right" | "justify" | "distributed"
  level?: number
  bullet?: PresentationOoxmlBullet
  margin_left?: PresentationOoxmlEmu
  indent?: PresentationOoxmlEmu
  space_before_points?: number
  space_after_points?: number
  line_spacing_points?: number
}

export type PresentationOoxmlTextBody = {
  paragraphs: PresentationOoxmlParagraph[]
  vertical_alignment?: "top" | "middle" | "bottom"
  wrap?: boolean
  auto_fit?: "none" | "shrink_text" | "resize_shape"
  margin_left?: PresentationOoxmlEmu
  margin_right?: PresentationOoxmlEmu
  margin_top?: PresentationOoxmlEmu
  margin_bottom?: PresentationOoxmlEmu
}

export type PresentationOoxmlBinding = {
  element_id: PresentationOoxmlIdentifier
  site_index?: number
}

export type PresentationOoxmlCrop = {
  left: number
  top: number
  right: number
  bottom: number
}

export type PresentationOoxmlFreeformPoint = {
  x: PresentationOoxmlEmu
  y: PresentationOoxmlEmu
  pressure?: number
}

export type PresentationOoxmlTableCell = {
  row: number
  column: number
  row_span?: number
  column_span?: number
  text: PresentationOoxmlTextBody
  fill?: PresentationOoxmlFill
}

export type PresentationOoxmlTable = {
  rows: number
  columns: number
  row_heights?: PresentationOoxmlPositiveEmu[]
  column_widths?: PresentationOoxmlPositiveEmu[]
  cells: PresentationOoxmlTableCell[]
}

export type PresentationOoxmlChart = {
  chart_type: string
  title?: string
  category_count?: number
  series_count?: number
  source_part?: string
}

export type PresentationOoxmlElement = (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown)

export type PresentationOoxmlAssetSource = {
  kind: "workspace"
  workspace_path: PresentationOoxmlPortablePath
} | {
  kind: "package"
  part_name: string
} | {
  kind: "external"
  url: string
}

export type PresentationOoxmlAsset = {
  id: PresentationOoxmlIdentifier
  kind: "image" | "audio" | "video" | "svg" | "binary"
  name?: string
  mime_type: string
  source: PresentationOoxmlAssetSource
  width?: PresentationOoxmlPositiveEmu
  height?: PresentationOoxmlPositiveEmu
  sha256?: string
}

export type PresentationOoxmlSlide = {
  id: PresentationOoxmlIdentifier
  name: string
  index: number
  master_name?: string
  layout_name?: string
  background?: PresentationOoxmlFill
  elements: PresentationOoxmlElement[]
  notes?: PresentationOoxmlTextBody
}

export type PresentationOoxmlTheme = {
  name?: string
  colors?: {
    [key: string]: PresentationOoxmlColor
  }
  major_font?: string
  minor_font?: string
}

export type PresentationOoxmlDocumentSource = {
  format: "kition_board" | "pptx" | "generated"
  workspace_path?: PresentationOoxmlPortablePath
  application?: string
}

export type PresentationOoxmlDocument = {
  type: "presentation.document"
  schema_version: 1
  title: string
  slide_size: {
    width: PresentationOoxmlPositiveEmu
    height: PresentationOoxmlPositiveEmu
  }
  theme?: PresentationOoxmlTheme
  slides: PresentationOoxmlSlide[]
  assets: PresentationOoxmlAsset[]
  source?: PresentationOoxmlDocumentSource
}

export type PresentationOoxmlWarning = {
  code: string
  message: string
  severity: "info" | "warning" | "error"
  slide_id?: PresentationOoxmlIdentifier
  element_id?: PresentationOoxmlIdentifier
}

export type PresentationOoxmlInspectRequest = {
  workspace_path: PresentationOoxmlPortablePath
  /**
   * @default true
   */
  include_notes?: boolean
  /**
   * @default true
   */
  include_unsupported?: boolean
}

export type PresentationOoxmlInspectResponse = {
  document: PresentationOoxmlDocument
  warnings: PresentationOoxmlWarning[]
}

export type PresentationOoxmlRenderRequest = {
  document: PresentationOoxmlDocument
  target_path: PresentationOoxmlPortablePath
  source_pptx_path?: PresentationOoxmlPortablePath
  /**
   * @default "rasterize"
   */
  unsupported_policy?: "preserve" | "rasterize" | "omit"
  /**
   * @default false
   */
  overwrite?: boolean
}

export type PresentationOoxmlRenderResponse = {
  path: PresentationOoxmlPortablePath
  mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  slide_count: number
  warnings: PresentationOoxmlWarning[]
}

/**
 * Versioned semantic presentation structure used to inspect and render PPTX files without exposing runtime implementation details.
 */
export type PresentationOoxmlContract = PresentationOoxmlDocument | PresentationOoxmlInspectRequest | PresentationOoxmlInspectResponse | PresentationOoxmlRenderRequest | PresentationOoxmlRenderResponse
