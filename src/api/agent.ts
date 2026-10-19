import request from './request'
import { resolveApiURL } from '@/services/desktop'
import { readAgentMessageStream, type AgentStreamNotification } from './agentStream'
import type { RuntimeWritingModel } from '@/types'
import type { AgentImageGenerationIntent } from '@/types/imageGeneration'
import type { AgentWhiteboardContext } from '@/types/whiteboardAgent'
import type { AgentDesignContext } from '@/types/designAgent'
import type { AgentSessionEventsPage } from './generated/agent-session-events'
import type {
  AgentCapabilities,
  AgentExecutionMode,
  AgentKitEditMode,
  AgentLocalSource,
  AgentPaneContext,
  AgentSession,
  AgentShellApprovalResponse,
  AgentSkillSpec,
  AgentSourceAdapterSpec,
  AgentTablePlanContext,
  AgentTaskMode,
} from './agentTypes'

export type * from './agentTypes'

export async function getAgentCapabilities() {
  return request.get<AgentCapabilities>('/v1/agent/capabilities')
}

export async function listAgentSkills() {
  return request.get<{ items: AgentSkillSpec[] }>('/v1/agent/skills')
}

export async function listAgentAdapters() {
  return request.get<{ items: AgentSourceAdapterSpec[] }>('/v1/agent/adapters')
}

export async function listAgentSessions() {
  return request.get<{ items: AgentSession[] }>('/v1/agent/sessions')
}

export async function createAgentSession(input: { title?: string; active_document_path?: string } = {}) {
  return request.post<AgentSession>('/v1/agent/sessions', input)
}

/**
 * The session event log after `after`, from its first event when `after` is
 * -1 (`contracts/runtime/agent-session-events.schema.json`).
 */
export async function listAgentSessionEvents(sessionId: number, after = -1) {
  return request.get<AgentSessionEventsPage>(`/v1/agent/sessions/${sessionId}/session-events`, {
    params: after < 0 ? {} : { after },
  })
}

export async function deleteAgentSession(sessionId: number) {
  return request.delete<{ deleted: boolean }>(`/v1/agent/sessions/${sessionId}`)
}

export type ExecPolicyRule = {
  prefix: string[]
  decision: 'allow' | 'prompt' | 'forbidden' | string
  justification?: string
  builtin?: boolean
}

export async function listExecPolicyRules() {
  return request.get<{ items: ExecPolicyRule[]; path: string }>('/v1/agent/exec-policy/rules')
}

export async function upsertExecPolicyRule(rule: {
  prefix: string[]
  decision: string
  justification?: string
}) {
  return request.post<{ saved: boolean; prefix: string[]; decision: string }>(
    '/v1/agent/exec-policy/rules',
    rule,
  )
}

export async function deleteExecPolicyRule(prefix: string[]) {
  return request.delete<{ removed: boolean; prefix: string[] }>('/v1/agent/exec-policy/rules', {
    data: { prefix },
  })
}

export type McpServerConfig = {
  name: string
  transport: 'stdio' | 'streamable_http' | string
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  auth_ref?: string
}

export type McpServerStatus = {
  name: string
  transport: string
  connected: boolean
  tool_count: number
  error?: string
  last_tried?: string
}

export type McpServerEntry = {
  config: McpServerConfig
  status: McpServerStatus
}

export type McpToolInfo = {
  server: string
  tool: string
  qualified: string
  title?: string
  description?: string
}

export async function listMcpServers() {
  return request.get<{
    items: McpServerEntry[]
    tools: McpToolInfo[]
    path: string
  }>('/v1/agent/mcp/servers')
}

export async function upsertMcpServer(config: McpServerConfig) {
  return request.post<{ saved: boolean; name: string }>('/v1/agent/mcp/servers', config)
}

export async function deleteMcpServer(name: string) {
  return request.delete<{ removed: boolean; name: string }>('/v1/agent/mcp/servers', {
    data: { name },
  })
}

export async function reloadMcpServers() {
  return request.post<{ reloaded: boolean; tools: number }>('/v1/agent/mcp/reload', {})
}

export async function streamAgentMessage(options: {
  sessionId: number
  content: string
  promptContext?: string
  attachmentPaths?: string[]
  localSources?: AgentLocalSource[]
  activeDocumentPath?: string
  activeDataDocumentId?: number | null
  activeDataTableId?: number | null
  /** Workflow id the user is editing when paneContext === 'workflow'.
   *  Backend loads the def + appends a compact summary to the skill
   *  context so the agent knows the trigger.type / bound table /
   *  action.type without having to call tools. Empty / missing → no
   *  workflow context is injected. */
  activeWorkflowId?: string
  /** Mirrors the workbench tab type the user has open ("document" /
   *  "workflow" / "table" / "gallery"). The backend uses
   *  this to add pane-specific guidance to the system prompt so the
   *  agent's behaviour matches what the user is actually looking at.
   *  Empty string / undefined defaults to "document". */
  paneContext?: AgentPaneContext
  executionMode?: AgentExecutionMode
  taskMode?: AgentTaskMode
  /** How kit tools edit open kit documents: live (the default) or as drafts to review. */
  kitEditMode?: AgentKitEditMode
  imageGenerationIntent?: AgentImageGenerationIntent
  whiteboardContext?: AgentWhiteboardContext
  designContext?: AgentDesignContext
  tablePlanContext?: AgentTablePlanContext
  shellApproval?: AgentShellApprovalResponse
  modelId?: string
  runtimeModel?: RuntimeWritingModel
  saveMarkdown?: boolean
  hideUserMessage?: boolean
  language?: string
  signal?: AbortSignal
  onNotification?: (notification: AgentStreamNotification) => void
}) {
  const response = await fetch(resolveApiURL(`/v1/agent/sessions/${options.sessionId}/messages/stream`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify({
      content: options.content,
      prompt_context: options.promptContext || '',
      attachment_paths: options.attachmentPaths || [],
      local_sources: options.localSources || [],
      active_document_path: options.activeDocumentPath || '',
      active_data_document_id: options.activeDataDocumentId || 0,
      active_data_table_id: options.activeDataTableId || 0,
      active_workflow_id: options.activeWorkflowId || '',
      pane_context: options.paneContext || '',
      execution_mode: options.executionMode || 'apply',
      task_mode: options.taskMode || 'auto',
      kit_edit_mode: options.kitEditMode || 'live',
      image_generation_intent: options.imageGenerationIntent || undefined,
      whiteboard_context: options.whiteboardContext || undefined,
      design_context: options.designContext || undefined,
      table_plan_context: options.tablePlanContext || undefined,
      shell_approval: options.shellApproval || undefined,
      model_id: options.modelId || '',
      runtime_model: options.runtimeModel || undefined,
      save_markdown: options.saveMarkdown,
      hide_user_message: options.hideUserMessage === true,
      language: options.language || '',
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const message = await response.text() || `Agent request failed (${response.status})`
    throw Object.assign(new Error(message), { status: response.status })
  }
  if (!response.body) {
    throw new Error('Agent streaming response is unavailable')
  }

  return readAgentMessageStream(response.body, options)
}
