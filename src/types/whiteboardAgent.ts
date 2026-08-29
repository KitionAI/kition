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
  locked?: boolean
  rotation?: number
  shape_type?: string
  shape_style?: string
  style?: {
    stroke_color?: 'ink' | 'gray' | 'purple' | 'green' | 'orange' | 'red' | 'yellow' | 'blue' | 'white'
    fill_color?: 'ink' | 'gray' | 'purple' | 'green' | 'orange' | 'red' | 'yellow' | 'blue' | 'white'
    opacity?: number
    fill_style?: 'none' | 'solid' | 'semi' | 'pattern'
    dash_style?: 'solid' | 'dashed' | 'dotted'
    stroke_size?: 's' | 'm' | 'l' | 'xl'
  }
  connector?: {
    type: 'straight' | 'elbow' | 'curved'
    start_arrowhead: 'none' | 'arrow' | 'dot'
    end_arrowhead: 'none' | 'arrow' | 'dot'
  }
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
  current_page: { id: string; name: string }
  current_tool: string
  active_style: AgentWhiteboardElement['style']
  viewport_snapshot?: {
    mime_type: 'image/svg+xml'
    data_url: string
  }
  lint_findings: Array<{
    code: string
    element_ids: string[]
    severity: 'warning'
  }>
}

export type AgentWhiteboardElementChanges = {
  kind?: AgentWhiteboardElementKind
  bounds?: AgentWhiteboardBounds
  text?: string
  parent_id?: string | null
  source_ref_ids?: string[]
}

export type AgentWhiteboardStyleChanges = NonNullable<AgentWhiteboardElement['style']>

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
  | {
      op: 'element.move'
      element_ids: string[]
      delta: { x: number; y: number }
    }
  | {
      op: 'element.rotate'
      element_ids: string[]
      degrees: number
    }
  | {
      op: 'element.resize'
      element_ids: string[]
      scale_x: number
      scale_y: number
    }
  | {
      op: 'element.style'
      element_ids: string[]
      style: AgentWhiteboardStyleChanges
    }
  | {
      op: 'layout.align'
      element_ids: string[]
      alignment: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom'
    }
  | {
      op: 'layout.distribute'
      element_ids: string[]
      direction: 'horizontal' | 'vertical'
    }
  | {
      op: 'layout.stack'
      element_ids: string[]
      direction: 'horizontal' | 'vertical'
      gap?: number
    }
  | {
      op: 'element.group'
      container_id: string
      container_kind: 'group' | 'frame'
      element_ids: string[]
    }
  | {
      op: 'element.ungroup'
      container_ids: string[]
    }

export type AgentWhiteboardPatch = {
  type: 'whiteboard.patch'
  schema_version: typeof AGENT_WHITEBOARD_SCHEMA_VERSION
  summary: string
  operations: AgentWhiteboardPatchOperation[]
}
