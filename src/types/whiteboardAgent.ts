export const AGENT_WHITEBOARD_CAPABILITY = 'agent_whiteboard_v1' as const

export const AGENT_WHITEBOARD_SCHEMA_VERSION = 1 as const
export const AGENT_WHITEBOARD_PATCH_OPERATION_LIMIT = 250 as const

export type AgentWhiteboardBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type AgentWhiteboardViewport = AgentWhiteboardBounds & {
  zoom: number
}

export type AgentWhiteboardElementKind =
  | 'shape'
  | 'text'
  | 'sticky'
  | 'image'
  | 'connector'
  | 'freehand'
  | 'mind_node'
  | 'flow_node'
  | 'frame'
  | 'group'

export type AgentWhiteboardElement = {
  id: string
  kind: AgentWhiteboardElementKind
  bounds: AgentWhiteboardBounds
  text?: string
  parent_id?: string
  source_ref_ids?: string[]
}

export type AgentWhiteboardCluster = {
  id: string
  bounds: AgentWhiteboardBounds
  element_count: number
  summary: string
}

export type AgentWhiteboardSourceReference = {
  id: string
  kind: 'document' | 'heading' | 'table_record' | 'research_source'
  label: string
  workspace_path?: string
  record_id?: string
  url?: string
}

export type AgentWhiteboardBoardReference = {
  id: string
  path: string
  title: string
}

export type AgentWhiteboardContext = {
  type: 'whiteboard.context'
  schema_version: typeof AGENT_WHITEBOARD_SCHEMA_VERSION
  board: AgentWhiteboardBoardReference
  scope: 'selection' | 'viewport' | 'board'
  viewport: AgentWhiteboardViewport
  selected_element_ids: string[]
  elements: AgentWhiteboardElement[]
  clusters: AgentWhiteboardCluster[]
  recent_operations: string[]
  source_refs: AgentWhiteboardSourceReference[]
}

export type AgentWhiteboardElementChanges = {
  kind?: AgentWhiteboardElementKind
  bounds?: AgentWhiteboardBounds
  text?: string
  parent_id?: string | null
  source_ref_ids?: string[]
}

export type AgentWhiteboardConnector = {
  id: string
  from_id: string
  to_id: string
}

export type AgentWhiteboardPatchOperation =
  | {
      op: 'element.create'
      element: AgentWhiteboardElement
    }
  | {
      op: 'connector.create'
      connector: AgentWhiteboardConnector
    }
  | {
      op: 'element.update'
      element_id: string
      changes: AgentWhiteboardElementChanges
    }
  | {
      op: 'element.delete'
      element_id: string
    }
  | {
      op: 'element.reorder'
      element_id: string
      after_element_id: string | null
    }

export type AgentWhiteboardPatch = {
  type: 'whiteboard.patch'
  schema_version: typeof AGENT_WHITEBOARD_SCHEMA_VERSION
  summary: string
  operations: AgentWhiteboardPatchOperation[]
}
