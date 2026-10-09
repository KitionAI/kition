import type { ApiTimestamp } from '@/types'
import type { AgentImageGenerationEvent } from '@/types/imageGeneration'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'
import type { AgentDesignPatch } from '@/types/designAgent'

export type AgentExecutionMode = 'research' | 'preview' | 'apply'
export type AgentTaskMode = 'auto' | 'browse' | 'table'

import type { AgentLocalSource } from '@/types/agentLocalSource'

export type { AgentLocalSource } from '@/types/agentLocalSource'

// AgentPaneContext mirrors the workbench tab the user has open when the
// turn is sent. The runtime echoes it back into the agent context, tool
// filter, and skill-context blocks. Wire format = literal lower/camelCase string; canonical
// source lives here so the UI / hook / turn-context / panel layers don't
// drift from the wire definition.
export type AgentPaneContext =
  | 'document'
  | 'workflow'
  | 'table'
  | 'gallery'
  | 'whiteboard'
  | 'design'

export type AgentTablePlanContext = {
  execution_mode?: string
  summary?: string
  source_scope?: string
  entity_name?: string
  proposed_fields?: string[]
  created_field_titles?: string[]
  recommended_unique_by?: string[]
  final_unique_by?: string[]
  estimated_create?: number
  estimated_update?: number
  estimated_skip?: number
  actual_created?: number
  actual_updated?: number
  actual_skipped?: number
  risks?: string[]
  notes?: string[]
  requires_apply_confirmation?: boolean
  applied?: boolean
}

export type AgentSession = {
  id: number
  user_id: number
  title: string
  workspace_root?: string
  active_document_path?: string
  status: 'idle' | 'running' | 'failed' | 'completed' | string
  model_id?: string
  system_prompt?: string
  created_at: ApiTimestamp
  updated_at: ApiTimestamp
}

export type AgentMessage = {
  id: number
  session_id: number
  user_id: number
  role: 'user' | 'assistant' | 'tool' | 'system' | string
  content: string
  parts?: any
  status: string
  created_at: ApiTimestamp
}

export type AgentArtifact = {
  id: number
  session_id: number
  user_id: number
  kind: 'markdown' | 'image' | 'file' | string
  path: string
  mime_type?: string
  title?: string
  created_at: ApiTimestamp
}

export type AgentToolCall = {
  id: number
  session_id: number
  message_id?: number
  user_id: number
  tool_name: string
  input_data?: any
  output_data?: any
  status: 'running' | 'completed' | 'failed' | string
  error_message?: string
  created_at: ApiTimestamp
  updated_at: ApiTimestamp
}

type AgentToolAvailability = {
  available: boolean
  reason: string
}

export type AgentTurnCapabilities = {
  available_tools: string[]
  hosted_web_search: AgentToolAvailability
}

export type AgentShellApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

type AgentShellApprovalRule = {
  prefix: string[]
  decision: 'allow'
}

export type AgentShellApprovalRequest = {
  tool_call_id: number
  command: string
  reason?: string
  suggested?: AgentShellApprovalRule
}

export type AgentShellApprovalResponse = {
  tool_call_id: number
  decision: AgentShellApprovalDecision
}

export type AgentEvent = {
  id: number
  session_id: number
  user_id: number
  message_id?: number
  tool_call_id?: number
  artifact_id?: number
  event_type: string
  stage?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | string
  label?: string
  message?: string
  data?: {
    turn_capabilities?: AgentTurnCapabilities
    turn?: number
    attempt?: number
    max_retries?: number
    delay_ms?: number
    reason?: string
    [key: string]: any
  }
  created_at: ApiTimestamp
}

type AgentToolSpec = {
  name: string
  description: string
  category: string
  input_schema?: any
  permission: string
  enabled: boolean
}

export type AgentSkillSpec = {
  name: string
  description: string
  triggers: string[]
  tools: string[]
}

type AgentAdapterCommandSpec = {
  name: string
  description: string
  mode: string
  entity_type?: string
  auth_required: boolean
  supports_table_ingest: boolean
  risk_level?: string
  navigation_hints?: string[]
  input_schema?: any
  output_schema?: any
}

export type AgentSourceAdapterSpec = {
  adapter: string
  label: string
  description?: string
  transport: string
  session_provider?: string
  primary_host?: string
  host_patterns?: string[]
  commands: AgentAdapterCommandSpec[]
}

export type AgentCapabilities = {
  tools: AgentToolSpec[]
  skills: AgentSkillSpec[]
  adapters: AgentSourceAdapterSpec[]
  governance: {
    permission_mode: string
    sandbox_enabled: boolean
    shell_enabled: boolean
  }
  surfaces: {
    http: boolean
    ndjson_stream: boolean
    local_source_access?: boolean
  }
}

export type AgentStreamEvent = {
  type: string
  board_path?: string
  delta?: string
  message?: string
  session?: AgentSession
  chat_message?: AgentMessage
  artifact?: AgentArtifact
  tool_call?: AgentToolCall
  event?: AgentEvent
  image_generation?: AgentImageGenerationEvent
  whiteboard_patch?: AgentWhiteboardPatch
  design_patch?: AgentDesignPatch
  design_path?: string
  provisional?: boolean
  done?: boolean
  extra_data?: {
    message?: AgentMessage
    session?: AgentSession
    artifact?: AgentArtifact
    image_generation?: AgentImageGenerationEvent
    [key: string]: any
  }
}
