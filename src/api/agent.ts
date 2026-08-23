import request from './request'
import { resolveApiURL } from '@/services/desktop'
import type { RuntimeWritingModel } from '@/types'
import type {
  AgentWhiteboardContext,
  AgentWhiteboardPatch,
} from '@/types/whiteboardAgent'

export type AgentExecutionMode = 'research' | 'preview' | 'apply'
export type AgentTaskMode = 'auto' | 'browse' | 'table'

export type AgentLocalSource = {
  id: string
  label: string
  root_path: string
  access: 'read'
}

// AgentPaneContext mirrors the workbench tab the user has open when the
// turn is sent. The runtime echoes it back into the agent context, tool
// filter, and skill-context blocks. Wire format = literal lower/camelCase string; canonical
// source lives here so the UI / hook / turn-context / panel layers don't
// drift from the wire definition.
export type AgentPaneContext =
  | 'document'
  | 'workflow'
  | 'table'
  | 'browser'
  | 'browserSites'
  | 'gallery'
  | 'whiteboard'

export type AgentBrowserContextLink = {
  text: string
  href: string
}

export type AgentBrowserContextEntity = {
  entity_type?: string
  url?: string
  title?: string
  author?: string
  published_at?: string
  summary?: string
}

export type AgentBrowserContextContentBlock = {
  url?: string
  title?: string
  summary?: string
  text?: string
  html?: string
}

export type AgentBrowserContext = {
  source?: string
  platform?: string
  adapter?: string
  command?: string
  entity_type?: string
  action?: string
  host?: string
  page_url?: string
  page_title?: string
  logged_in?: boolean
  supported_page?: boolean
  editor_ready?: boolean
  page_heading?: string
  title_text?: string
  content_text_preview?: string
  visible_text_preview?: string
  main_content_html?: string
  html_snapshot?: string
  content_blocks?: AgentBrowserContextContentBlock[]
  page_type?: string
  links?: AgentBrowserContextLink[]
  extracted_entities?: AgentBrowserContextEntity[]
  extracted_at?: string
}

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
  created_at: string
  updated_at: string
}

export type AgentMessage = {
  id: number
  session_id: number
  user_id: number
  role: 'user' | 'assistant' | 'tool' | 'system' | string
  content: string
  parts?: any
  status: string
  created_at: string
}

export type AgentArtifact = {
  id: number
  session_id: number
  user_id: number
  kind: 'markdown' | 'image' | 'file' | string
  path: string
  mime_type?: string
  title?: string
  created_at: string
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
  created_at: string
  updated_at: string
}

export type AgentToolAvailability = {
  available: boolean
  reason: string
}

export type AgentTurnCapabilities = {
  available_tools: string[]
  hosted_web_search: AgentToolAvailability
  browser_search: AgentToolAvailability
}

export type AgentShellApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

export type AgentShellApprovalRule = {
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

export type AgentModelReconnectData = {
  turn: number
  attempt: number
  max_retries: 5
  delay_ms: number
  reason:
    | 'tls_handshake_timeout'
    | 'connection_timeout'
    | 'connection_closed'
    | 'connection_reset'
    | 'dns_failure'
    | 'network_error'
    | 'request_timeout'
    | 'rate_limited'
    | 'server_unavailable'
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
  created_at: string
}

export type AgentToolSpec = {
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

export type AgentAdapterCommandSpec = {
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
  delta?: string
  message?: string
  session?: AgentSession
  chat_message?: AgentMessage
  artifact?: AgentArtifact
  tool_call?: AgentToolCall
  event?: AgentEvent
  whiteboard_patch?: AgentWhiteboardPatch
  provisional?: boolean
  done?: boolean
  extra_data?: {
    message?: AgentMessage
    session?: AgentSession
    artifact?: AgentArtifact
    [key: string]: any
  }
}

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

export async function createAgentSession(input: { title?: string; active_document_path?: string; language?: string } = {}) {
  return request.post<AgentSession>('/v1/agent/sessions', input)
}

export async function listAgentMessages(sessionId: number) {
  return request.get<{ items: AgentMessage[] }>(`/v1/agent/sessions/${sessionId}/messages`)
}

export async function listAgentToolCalls(sessionId: number) {
  return request.get<{ items: AgentToolCall[] }>(`/v1/agent/sessions/${sessionId}/tool-calls`)
}

export async function listAgentEvents(sessionId: number) {
  return request.get<{ items: AgentEvent[] }>(`/v1/agent/sessions/${sessionId}/events`)
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
   *  "workflow" / "table" / "browser" / "gallery"). The backend uses
   *  this to add pane-specific guidance to the system prompt so the
   *  agent's behaviour matches what the user is actually looking at.
   *  Empty string / undefined defaults to "document". */
  paneContext?: AgentPaneContext
  executionMode?: AgentExecutionMode
  taskMode?: AgentTaskMode
  browserEnabled?: boolean
  browserContext?: AgentBrowserContext
  whiteboardContext?: AgentWhiteboardContext
  tablePlanContext?: AgentTablePlanContext
  shellApproval?: AgentShellApprovalResponse
  modelId?: string
  runtimeModel?: RuntimeWritingModel
  saveMarkdown?: boolean
  hideUserMessage?: boolean
  language?: string
  signal?: AbortSignal
  onEvent?: (event: AgentStreamEvent) => void
  onDelta?: (delta: string) => void
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
      browser_enabled: options.browserEnabled === true,
      browser_context: options.browserContext || undefined,
      whiteboard_context: options.whiteboardContext || undefined,
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
    throw new Error(await response.text() || `Agent request failed (${response.status})`)
  }
  if (!response.body) {
    throw new Error('Agent streaming response is unavailable')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent: AgentStreamEvent | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const event = parseAgentStreamLine(line)
      if (!event) {
        continue
      }
      if (event.type === 'delta' && event.delta) {
        options.onDelta?.(event.delta)
      }
      if (event.type === 'error') {
        throw new Error(event.message || 'Agent execution failed')
      }
      options.onEvent?.(event)
      if (event.type === 'done') {
        doneEvent = event
      }
    }
  }

  const finalEvent = parseAgentStreamLine(buffer)
  if (finalEvent) {
    if (finalEvent.type === 'delta' && finalEvent.delta) {
      options.onDelta?.(finalEvent.delta)
    }
    if (finalEvent.type === 'error') {
      throw new Error(finalEvent.message || 'Agent execution failed')
    }
    options.onEvent?.(finalEvent)
    if (finalEvent.type === 'done') {
      doneEvent = finalEvent
    }
  }

  return doneEvent
}

function parseAgentStreamLine(line: string): AgentStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  return JSON.parse(trimmed) as AgentStreamEvent
}
