/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-design.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentDesignIdentifier = string

export type AgentDesignPortablePath = string

export type AgentDesignColor = string

/**
 * Axis-aligned box in artboard pixels, before rotation.
 */
export type AgentDesignBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type AgentDesignLayerKind = "text" | "image" | "rectangle" | "ellipse" | "line" | "group"

export type AgentDesignCreatableLayerKind = "text" | "rectangle" | "ellipse" | "line"

/**
 * Hint about what a layer is for, derived by the client; never authoritative.
 */
export type AgentDesignLayerRole = "headline" | "body" | "label" | "accent" | "background" | "image" | "group"

export type AgentDesignFontFamily = "Arial" | "Georgia" | "Courier New" | "Inter" | "Lora" | "JetBrains Mono" | "Bricolage Grotesque"

export type AgentDesignStyle = {
  fill?: AgentDesignColor
  stroke?: AgentDesignColor
  stroke_width?: number
  radius?: number
  opacity?: number
  font_family?: AgentDesignFontFamily
  font_size?: number
  font_weight?: number
  text_align?: "left" | "center" | "right"
  line_height?: number
  letter_spacing?: number
}

export type AgentDesignLayer = {
  id: AgentDesignIdentifier
  kind: AgentDesignLayerKind
  name?: string
  bounds: AgentDesignBounds
  rotation?: number
  text?: string
  style?: AgentDesignStyle
  role?: AgentDesignLayerRole
  parent_id?: AgentDesignIdentifier
  locked?: boolean
}

export type AgentDesignCreatableLayer = (AgentDesignLayer) & ({
  kind?: AgentDesignCreatableLayerKind
  bounds?: {
    width?: number
    height?: number
  }
})

export type AgentDesignDesignReference = {
  id: AgentDesignIdentifier
  path: AgentDesignPortablePath
  title: string
}

export type AgentDesignArtboard = {
  width: number
  height: number
  background: AgentDesignColor
}

/**
 * Summary of the workspace brand kit, when one exists.
 */
export type AgentDesignBrand = {
  colors?: AgentDesignColor[]
  fonts?: AgentDesignFontFamily[]
}

export type AgentDesignLayerIds = AgentDesignIdentifier[]

export type AgentDesignContext = {
  type: "design.context"
  schema_version: 1
  design: AgentDesignDesignReference
  artboard: AgentDesignArtboard
  brand?: AgentDesignBrand
  selected_layer_ids: AgentDesignIdentifier[]
  layers: AgentDesignLayer[]
  recent_operations: string[]
}

export type AgentDesignPatchOperation = {
  op: "text.set"
  layer_id: AgentDesignIdentifier
  text: string
} | {
  op: "style.set"
  layer_ids: AgentDesignLayerIds
  style: (AgentDesignStyle) & (unknown)
} | {
  op: "layer.create"
  layer: AgentDesignCreatableLayer
} | {
  op: "layer.move"
  layer_ids: AgentDesignLayerIds
  delta: {
    x: number
    y: number
  }
} | {
  op: "layer.resize"
  layer_id: AgentDesignIdentifier
  bounds: AgentDesignBounds
} | {
  op: "layer.reorder"
  layer_id: AgentDesignIdentifier
  direction: "forward" | "backward"
} | {
  op: "layer.delete"
  layer_ids: AgentDesignLayerIds
} | {
  op: "layout.align"
  layer_ids: AgentDesignLayerIds
  edge: "left" | "centerX" | "right" | "top" | "centerY" | "bottom"
  reference?: "selection" | "artboard"
} | {
  op: "layout.distribute"
  layer_ids: AgentDesignLayerIds
  axis: "x" | "y"
} | {
  op: "artboard.background"
  background: AgentDesignColor
}

export type AgentDesignPatch = {
  type: "design.patch"
  schema_version: 1
  summary: string
  operations: AgentDesignPatchOperation[]
}

/**
 * Bounded semantic Design context and typed preview patches for one artboard. Payloads must not contain credentials, host root paths, image bytes, or unrelated workspace content. Images enter a design only through the image generation contract.
 */
export type AgentDesignContract = AgentDesignContext | AgentDesignPatch
