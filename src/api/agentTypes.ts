import type { ApiTimestamp } from '@/types'
import type { AgentShellApprovalRequest as AgentShellApprovalMeta } from './generated/agent-shell-approval'

export type {
  AgentShellApprovalDecision,
  AgentShellApprovalResponse,
} from './generated/agent-shell-approval'

export type AgentExecutionMode = 'research' | 'preview' | 'apply'
export type AgentTaskMode = 'auto' | 'browse'
/** How the agent edits open kit documents (Kit Standard 2.0 A12). */
export type AgentKitEditMode = 'live' | 'draft'

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
  | 'gallery'
  | 'whiteboard'
  | 'design'

export type AgentSession = {
  id: number
  user_id: number
  title: string
  workspace_root?: string
  active_document_path?: string
  model_id?: string
  created_at: ApiTimestamp
  updated_at: ApiTimestamp
}

/** A paused command (the logged result meta) and the call it belongs to. */
export type AgentShellApprovalRequest = AgentShellApprovalMeta & { call_id: string }

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
