/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-whiteboard.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentWhiteboardIdentifier = string

export type AgentWhiteboardPortablePath = string

export type AgentWhiteboardBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type AgentWhiteboardViewport = {
  x: number
  y: number
  width: number
  height: number
  zoom: number
}

export type AgentWhiteboardElementKind = "shape" | "text" | "sticky" | "image" | "connector" | "freehand" | "mind_node" | "flow_node" | "frame" | "group"

export type AgentWhiteboardElement = {
  id: AgentWhiteboardIdentifier
  kind: AgentWhiteboardElementKind
  bounds: AgentWhiteboardBounds
  text?: string
  parent_id?: AgentWhiteboardIdentifier
  source_ref_ids?: AgentWhiteboardIdentifier[]
}

export type AgentWhiteboardCreatableElement = (AgentWhiteboardElement) & ({
  kind?: unknown
})

export type AgentWhiteboardCluster = {
  id: AgentWhiteboardIdentifier
  bounds: AgentWhiteboardBounds
  element_count: number
  summary: string
}

export type AgentWhiteboardSourceReference = {
  id: AgentWhiteboardIdentifier
  kind: "document" | "heading" | "table_record" | "research_source"
  label: string
  workspace_path?: AgentWhiteboardPortablePath
  record_id?: string
  url?: string
}

export type AgentWhiteboardBoardReference = {
  id: AgentWhiteboardIdentifier
  path: AgentWhiteboardPortablePath
  title: string
}

export type AgentWhiteboardContext = {
  type: "whiteboard.context"
  schema_version: 1
  board: AgentWhiteboardBoardReference
  scope: "selection" | "viewport" | "board"
  viewport: AgentWhiteboardViewport
  selected_element_ids: AgentWhiteboardIdentifier[]
  elements: AgentWhiteboardElement[]
  clusters: AgentWhiteboardCluster[]
  recent_operations: string[]
  source_refs: AgentWhiteboardSourceReference[]
}

export type AgentWhiteboardElementChanges = {
  kind?: AgentWhiteboardElementKind
  bounds?: AgentWhiteboardBounds
  text?: string
  parent_id?: AgentWhiteboardIdentifier | null
  source_ref_ids?: AgentWhiteboardIdentifier[]
}

export type AgentWhiteboardConnector = {
  id: AgentWhiteboardIdentifier
  from_id: AgentWhiteboardIdentifier
  to_id: AgentWhiteboardIdentifier
}

export type AgentWhiteboardPatchOperation = {
  op: "element.create"
  element: AgentWhiteboardCreatableElement
} | {
  op: "connector.create"
  connector: AgentWhiteboardConnector
} | {
  op: "element.update"
  element_id: AgentWhiteboardIdentifier
  changes: AgentWhiteboardElementChanges
} | {
  op: "element.delete"
  element_id: AgentWhiteboardIdentifier
} | {
  op: "element.reorder"
  element_id: AgentWhiteboardIdentifier
  after_element_id: AgentWhiteboardIdentifier | null
}

export type AgentWhiteboardPatch = {
  type: "whiteboard.patch"
  schema_version: 1
  summary: string
  operations: AgentWhiteboardPatchOperation[]
}

/**
 * Bounded semantic Whiteboard context and typed preview patches. Payloads must not contain credentials, host root paths, or unrelated workspace content.
 */
export type AgentWhiteboardContract = AgentWhiteboardContext | AgentWhiteboardPatch
