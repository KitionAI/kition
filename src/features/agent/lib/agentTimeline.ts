import {
  FileText,
  FileType2,
  FileSpreadsheet,
  Globe2,
  Image as ImageIcon,
  Presentation,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AgentArtifact, AgentEvent, AgentMessage, AgentSkillSpec, AgentToolCall } from '@/api/agent'
import {
  DEFAULT_AGENT_TIMELINE_LOCALE,
  type AgentTimelineLocale,
  getAgentTimelineDict,
  getAgentToolActionLabel,
  getAgentToolDisplayName,
  parseMcpToolName,
} from './agentTimelineI18n'

export type { AgentTimelineLocale } from './agentTimelineI18n'
export { DEFAULT_AGENT_TIMELINE_LOCALE, resolveAgentTimelineLocale } from './agentTimelineI18n'

export type AgentTaskStep = {
  key: string
  label: string
  detail: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export type AgentRunLogItem = {
  key: string
  kind: 'event' | 'tool' | 'artifact' | 'model' | 'final'
  title: string
  detail?: string
  status: AgentTaskStep['status']
  toolName?: string
  payload?: any
  createdAt: string
}

export type AgentToolImageResult = {
  url: string
  preview_url?: string
  thumb_url?: string
  title?: string
  alt?: string
  page_url?: string
  source?: string
}

export type AgentConversationTurn = {
  key: string
  userMessage: AgentMessage | null
  replies: AgentMessage[]
}

// Group a flat message list into conversational turns. Each user message opens a
// new turn; following assistant/image messages attach to it. Assistant messages
// that arrive before any user message form a leading turn with no user bubble.
export function buildAgentConversationTurns(messages: AgentMessage[]): AgentConversationTurn[] {
  const turns: AgentConversationTurn[] = []
  let current: AgentConversationTurn | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      current = { key: `turn-${message.id}`, userMessage: message, replies: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { key: `turn-lead-${message.id}`, userMessage: null, replies: [] }
      turns.push(current)
    }
    current.replies.push(message)
  }
  return turns
}

// Attach execution items to the turn whose user message triggered them. Items
// without a message_id (live streaming deltas, synthetic events) belong to the
// active turn, so includeOrphans is set only for the last turn.
export function scopeAgentTurnToolCallsById(
  toolCalls: AgentToolCall[],
  userMessageId: number,
  includeOrphans: boolean,
): AgentToolCall[] {
  return toolCalls.filter((toolCall) => {
    const messageId = toolCall.message_id ?? 0
    return messageId > 0 ? messageId === userMessageId : includeOrphans
  })
}

export function scopeAgentTurnEventsById(
  events: AgentEvent[],
  userMessageId: number,
  includeOrphans: boolean,
): AgentEvent[] {
  return events.filter((event) => {
    const messageId = event.message_id ?? 0
    return messageId > 0 ? messageId === userMessageId : includeOrphans
  })
}

// Artifacts carry no message_id, so attribute them to a turn by created_at: the
// open-ended (active) turn owns artifacts created at or after its user message.
export function scopeAgentTurnArtifacts(
  artifacts: AgentArtifact[],
  startISO: string | null,
  endISO: string | null,
): AgentArtifact[] {
  const start = startISO ? safeAgentTime(startISO) : 0
  const end = endISO ? safeAgentTime(endISO) : Number.POSITIVE_INFINITY
  return artifacts.filter((artifact) => {
    const created = safeAgentTime(artifact.created_at)
    if (!created) {
      return end === Number.POSITIVE_INFINITY
    }
    return created >= start && created < end
  })
}

// Model-protocol chatter that only matters when inspecting the run. Hidden unless debug mode is on,
// leaving tool calls, artifacts, and task completion/failure as the default activity log.
const AGENT_DEBUG_EVENT_TYPES = new Set<string>([
  'task.started',
  'skill.enabled',
  'prompt.sent',
  'model.turn.started',
  'model.delta',
  'model.tool_call.delta',
  'model.tool_call.ready',
  'model.turn.completed',
  'response.completed',
])

export function buildAgentRunLogItems({
  events,
  toolCalls,
  artifacts,
  busy,
  streamingText,
  debug = false,
  locale = DEFAULT_AGENT_TIMELINE_LOCALE,
}: {
  events: AgentEvent[]
  toolCalls: AgentToolCall[]
  artifacts: AgentArtifact[]
  busy: boolean
  streamingText: string
  debug?: boolean
  locale?: AgentTimelineLocale
}): AgentRunLogItem[] {
  const dict = getAgentTimelineDict(locale)
  const items: AgentRunLogItem[] = []
  const artifactPathsFromTools = new Set<string>()
  const completedModelTurns = new Set(
    events
      .filter((event) => event.event_type === 'model.turn.completed')
      .map((event) => agentEventTurn(event))
      .filter((turn): turn is number => turn > 0),
  )

  events
    .filter((event) => !event.event_type.startsWith('tool.'))
    .filter((event) => debug || !AGENT_DEBUG_EVENT_TYPES.has(event.event_type))
    .forEach((event) => {
      const item = formatAgentRunLogEvent(event, busy, completedModelTurns, locale)
      if (item) {
        items.push(item)
      }
    })

  toolCalls.forEach((toolCall) => {
    const outputPath = typeof toolCall.output_data?.path === 'string' ? toolCall.output_data.path : ''
    if (outputPath) {
      artifactPathsFromTools.add(outputPath)
    }

    items.push({
      key: `tool-${toolCall.id}`,
      kind: 'tool',
      title: formatAgentToolRunTitle(toolCall, locale),
      detail: formatAgentToolRunDetail(toolCall, locale),
      status: normalizeAgentTaskStepStatus(toolCall.status),
      toolName: toolCall.tool_name,
      payload: {
        tool: toolCall.tool_name,
        status: toolCall.status,
        input: toolCall.input_data,
        output: toolCall.output_data,
        error: toolCall.error_message,
        created_at: toolCall.created_at,
        updated_at: toolCall.updated_at,
      },
      createdAt: toolCall.created_at || toolCall.updated_at || '',
    })
  })

  artifacts.forEach((artifact) => {
    if (artifactPathsFromTools.has(artifact.path)) {
      return
    }

    items.push({
      key: `artifact-${artifact.id}`,
      kind: 'artifact',
      title: dict.artifact.title,
      detail: artifact.path,
      status: 'completed',
      payload: {
        kind: artifact.kind,
        path: artifact.path,
        mime_type: artifact.mime_type,
        title: artifact.title,
        created_at: artifact.created_at,
      },
      createdAt: artifact.created_at,
    })
  })

  if (streamingText) {
    items.push({
      key: 'final-streaming',
      kind: 'final',
      title: dict.final.streaming,
      detail: compactAgentRunDetail(streamingText, locale),
      status: 'running',
      payload: {
        preview: compactAgentRunDetail(streamingText, locale),
      },
      createdAt: new Date().toISOString(),
    })
  }

  const hasRunningItem = items.some((item) => item.status === 'running')
  if (busy && !hasRunningItem) {
    const latestTool = toolCalls[toolCalls.length - 1]
    const toolLabel = latestTool ? getAgentToolDisplayName(latestTool.tool_name, locale) : ''
    const detail = latestTool ? dict.model.detailProcessing(toolLabel) : dict.model.detailPlanning

    items.push({
      key: 'model-thinking',
      kind: 'model',
      title: latestTool ? dict.model.titleProcessing : dict.model.titlePlanning,
      detail,
      status: 'running',
      payload: {
        state: latestTool ? 'processing_tool_result' : 'planning',
        latest_tool: toolLabel || undefined,
      },
      createdAt: new Date().toISOString(),
    })
  }

  return items
    .sort((a, b) => safeAgentTime(a.createdAt) - safeAgentTime(b.createdAt))
    .slice(-12)
}

export function extractAgentActiveSkills(events: AgentEvent[]): AgentSkillSpec[] {
  const skillEvent = [...events].reverse().find(
    (event) => event.event_type === 'skill.enabled' && Array.isArray(event.data?.skills),
  )
  if (!skillEvent) {
    return []
  }

  return skillEvent.data.skills.filter(
    (skill: Partial<AgentSkillSpec>) => typeof skill?.name === 'string',
  ) as AgentSkillSpec[]
}

export function formatCurrentAgentActivity({
  toolCalls,
  events,
  busy,
  streamingText,
  locale = DEFAULT_AGENT_TIMELINE_LOCALE,
}: {
  toolCalls: AgentToolCall[]
  events: AgentEvent[]
  busy: boolean
  streamingText: string
  locale?: AgentTimelineLocale
}) {
  const dict = getAgentTimelineDict(locale)
  const runningTool = [...toolCalls].reverse().find((item) => item.status === 'running')
  if (runningTool) {
    return dict.activity.running(getAgentToolDisplayName(runningTool.tool_name, locale))
  }

  const failedTool = [...toolCalls].reverse().find((item) => item.status === 'failed')
  if (failedTool && !busy) {
    return dict.activity.failed(getAgentToolDisplayName(failedTool.tool_name, locale))
  }

  const latestEvent = events[events.length - 1]
  if (latestEvent?.label) {
    return latestEvent.label
  }
  if (streamingText) {
    return dict.activity.preparingFinal
  }
  if (busy) {
    return dict.activity.planningNext
  }
  if (toolCalls.length) {
    return dict.activity.taskCompleted
  }
  return dict.activity.waiting
}

export function formatAgentRunLogExpandedDetail(
  item: AgentRunLogItem,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (item.payload == null) {
    return item.detail || ''
  }
  if (typeof item.payload === 'string') {
    return item.payload
  }
  if (item.kind === 'tool') {
    const rows: string[] = []
    if (item.payload.tool) {
      rows.push(`${dict.sections.tool}\n${getAgentToolDisplayName(String(item.payload.tool), locale)}`)
    }
    if (item.payload.input != null) {
      rows.push(`${dict.sections.input}\n${formatAgentToolDetail(item.payload.input)}`)
    }
    if (item.payload.output != null) {
      rows.push(`${dict.sections.output}\n${formatAgentToolDetail(item.payload.output)}`)
    }
    if (item.payload.error) {
      rows.push(`${dict.sections.error}\n${String(item.payload.error)}`)
    }
    if (rows.length) {
      return rows.join('\n\n')
    }
    return dict.sections.noDetail
  }
  if (item.kind === 'event') {
    const rows: string[] = []
    if (item.payload.message) {
      rows.push(`${dict.sections.status}\n${String(item.payload.message)}`)
    }
    if (item.payload.type === 'model.delta' && item.payload.data?.preview) {
      rows.push(`${dict.sections.backendContent}\n${String(item.payload.data.preview)}`)
    }
    if (
      (item.payload.type === 'model.tool_call.delta' || item.payload.type === 'model.tool_call.ready')
      && item.payload.data?.arguments
    ) {
      rows.push(`${dict.sections.toolArguments}\n${String(item.payload.data.arguments)}`)
    }
    if (item.payload.data && !item.payload.data.preview && !item.payload.data.arguments) {
      rows.push(`${dict.sections.data}\n${formatAgentToolDetail(item.payload.data)}`)
    }
    if (rows.length) {
      return rows.join('\n\n')
    }
    return item.detail || dict.sections.noDetail
  }
  if (item.kind === 'model') {
    const toolLabel = typeof item.payload.latest_tool === 'string' ? item.payload.latest_tool : ''
    if (item.payload.state === 'processing_tool_result' && toolLabel) {
      return dict.model.expandedProcessing(toolLabel)
    }
    return dict.model.expandedPlanning
  }
  if (item.kind === 'artifact') {
    const rows: string[] = []
    if (item.payload.title) {
      rows.push(`${dict.sections.title}\n${String(item.payload.title)}`)
    }
    if (item.payload.path) {
      rows.push(`${dict.sections.path}\n${String(item.payload.path)}`)
    }
    if (item.payload.kind) {
      rows.push(`${dict.sections.type}\n${String(item.payload.kind)}`)
    }
    if (item.payload.mime_type) {
      rows.push(`${dict.sections.mimeType}\n${String(item.payload.mime_type)}`)
    }
    if (item.payload.created_at) {
      rows.push(`${dict.sections.createdAt}\n${String(item.payload.created_at)}`)
    }
    if (rows.length) {
      return rows.join('\n\n')
    }
    return dict.sections.noDetail
  }
  if (item.kind === 'final') {
    if (typeof item.payload.preview === 'string' && item.payload.preview.trim()) {
      return `${dict.sections.preview}\n${item.payload.preview}`
    }
    return item.detail || dict.sections.noDetail
  }
  return item.detail || dict.sections.noDetail
}

export function getAgentModifiedDocumentPaths(toolCalls: AgentToolCall[]) {
  const paths = new Set<string>()
  toolCalls.forEach((toolCall) => {
    if (toolCall.status !== 'completed') {
      return
    }

    if (toolCall.tool_name === 'document_write') {
      const path = typeof toolCall.output_data?.path === 'string'
        ? toolCall.output_data.path
        : typeof toolCall.input_data?.path === 'string'
          ? toolCall.input_data.path
          : ''

      if (path) {
        paths.add(path)
      }
      return
    }

    if (toolCall.tool_name === 'data_table_create') {
      const output = toolCall.output_data || {}
      const input = toolCall.input_data || {}
      const path = [
        output.path,
        output.document_path,
        output.kitable_path,
        output.vault_path,
        output.document?.path,
        output.data?.path,
        input.path,
        input.document_path,
        input.kitable_path,
        input.vault_path,
      ].find((value) => typeof value === 'string' && value.trim())

      if (typeof path === 'string') {
        paths.add(path)
      }
      return
    }

    if (toolCall.tool_name === 'apply_patch') {
      const output = toolCall.output_data || {}
      const operations = [
        ...(Array.isArray(output.file_ops) ? output.file_ops : []),
        ...(Array.isArray(output.changes) ? output.changes : []),
      ]
      operations.forEach((operation: any) => {
        if (typeof operation?.path === 'string' && operation.path) {
          paths.add(operation.path)
        }
      })
    }
  })
  return paths
}

export function resolveAgentToolIcon(toolName: string, outputPath?: string): LucideIcon {
  if ((toolName === 'artifact_write' || toolName === 'register_artifact') && outputPath) {
    const ext = outputPath.slice(outputPath.lastIndexOf('.')).toLowerCase()
    if (ext === '.pptx') {
      return Presentation
    }
    if (ext === '.xlsx') {
      return FileSpreadsheet
    }
    if (ext === '.docx') {
      return FileType2
    }
    if (ext === '.html' || ext === '.htm' || ext === '.md' || ext === '.markdown' || ext === '.txt') {
      return FileText
    }
    return FileText
  }
  if (toolName.includes('web')) {
    return Globe2
  }
  if (toolName.includes('image')) {
    return ImageIcon
  }
  if (toolName.includes('ppt')) {
    return Presentation
  }
  if (toolName.includes('xlsx')) {
    return FileSpreadsheet
  }
  if (toolName.includes('docx')) {
    return FileType2
  }
  if (toolName.includes('shell') || toolName.includes('exec')) {
    return Terminal
  }
  if (toolName.includes('document') || toolName.includes('markdown')) {
    return FileText
  }
  return Wrench
}

export { parseMcpToolName }

export function formatAgentToolName(
  toolName: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  return getAgentToolDisplayName(toolName, locale)
}

export function formatAgentToolStatus(
  status: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (status === 'running') {
    return dict.status.running
  }
  if (status === 'failed') {
    return dict.status.failed
  }
  if (status === 'completed') {
    return dict.status.completed
  }
  return status || dict.status.unknown
}

export function formatAgentToolHeadline(
  toolCall: AgentToolCall,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  const input = toolCall.input_data || {}
  const output = toolCall.output_data || {}
  if (toolCall.tool_name === 'browser_open' && (input.url || input.host || output.url)) {
    return String(output.url || input.url || input.host)
  }
  if (toolCall.tool_name === 'browser_navigate' && (input.url || output.url)) {
    return String(output.url || input.url)
  }
  if (toolCall.tool_name === 'browser_search' && input.query) {
    return dict.tool.searchInBrowserPrefix(String(input.query))
  }
  if (toolCall.tool_name === 'source_adapter_catalog' && (input.host || input.site || input.domain)) {
    return String(input.host || input.site || input.domain)
  }
  if (toolCall.tool_name === 'browser_context_entities' && (output.source_scope || input.page_url)) {
    return String(output.source_scope || input.page_url)
  }
  if (toolCall.tool_name === 'browser_ingest_strategy' && (output.next_action || output.target_page_type)) {
    return [output.next_action, output.target_page_type].filter(Boolean).join(' · ')
  }
  if (toolCall.tool_name === 'shell_exec' && input.command) {
    if (output && output.requires === 'approval') {
      return dict.tool.pendingApproval(String(input.command))
    }
    return `$ ${input.command}`
  }
  {
    const mcp = parseMcpToolName(toolCall.tool_name)
    if (mcp) {
      const text = typeof output.text === 'string' ? output.text.trim() : ''
      if (text) {
        return `${mcp.server} · ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`
      }
      return `${mcp.server} · ${mcp.tool}`
    }
  }
  if (toolCall.tool_name === 'web_search' && input.query) {
    return dict.tool.searchPrefix(String(input.query))
  }
  if (toolCall.tool_name === 'image_search' && input.query) {
    return dict.tool.generateImagePrefix(String(input.query))
  }
  if (toolCall.tool_name === 'web_fetch' && Array.isArray(input.urls)) {
    return input.urls.join(', ')
  }
  if (toolCall.tool_name === 'save_image_asset' && (output.path || input.url)) {
    return String(output.path || input.url)
  }
  if (
    (toolCall.tool_name === 'document_read'
      || toolCall.tool_name === 'document_write'
      || toolCall.tool_name === 'document_search')
    && (input.path || input.query || output.path)
  ) {
    if (toolCall.tool_name === 'document_write') {
      return `@ ${String(output.path || input.path)}`
    }
    return String(input.path || input.query)
  }
  if (toolCall.tool_name === 'apply_patch') {
    const ops = Array.isArray(output.file_ops) ? output.file_ops : []
    const fileCount = ops.length || (Array.isArray(output.changes) ? output.changes.length : 0)
    const added = ops.reduce((sum: number, op: any) => sum + (Number(op?.lines_added) || 0), 0)
    const removed = ops.reduce((sum: number, op: any) => sum + (Number(op?.lines_removed) || 0), 0)
    if (fileCount) {
      return output.dry_run
        ? dict.tool.previewNFiles(fileCount, added, removed)
        : dict.tool.appliedNFiles(fileCount, added, removed)
    }
  }
  if (toolCall.tool_name === 'file_search') {
    if (input.query) {
      const total = Number(output.total_match_count) || 0
      return total ? `${input.query} · ${dict.tool.nMatches(total)}` : String(input.query)
    }
  }
  if (toolCall.tool_name === 'fs_read' || toolCall.tool_name === 'fs_stat' || toolCall.tool_name === 'fs_mkdir') {
    if (output.path || input.path) {
      return String(output.path || input.path)
    }
  }
  if (toolCall.tool_name === 'fs_list') {
    const count = Number(output.count) || 0
    const path = String(output.path || input.path || '/')
    return count ? `${path} · ${dict.tool.nEntries(count)}` : path
  }
  if (toolCall.tool_name === 'fs_remove') {
    if (output.path || input.path) {
      return dict.tool.removed(String(output.path || input.path))
    }
  }
  if (toolCall.tool_name === 'fs_copy') {
    if ((output.src || input.src) && (output.dst || input.dst)) {
      return `${String(output.src || input.src)} → ${String(output.dst || input.dst)}`
    }
  }
  if ((toolCall.tool_name.includes('create') || toolCall.tool_name.includes('markdown')) && (output.path || input.title)) {
    return String(output.path || input.title)
  }
  return ''
}

export function formatAgentToolPayload(
  value: any,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (!value) {
    return ''
  }
  if (typeof value === 'string') {
    const normalized = sanitizeAgentVisibleDetail(value, locale)
    return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized
  }
  if (value.path) {
    return String(value.path)
  }
  if (value.query) {
    return String(value.query)
  }
  if (Array.isArray(value.results)) {
    return dict.tool.nResults(value.results.length)
  }
  if (Array.isArray(value.images)) {
    return dict.tool.nImages(value.images.length)
  }
  try {
    const json = sanitizeAgentVisibleDetail(JSON.stringify(value), locale)
    return json.length > 180 ? `${json.slice(0, 180)}...` : json
  } catch {
    return ''
  }
}

export function extractAgentToolImageResults(value: any): AgentToolImageResult[] {
  if (!value || !Array.isArray(value.images)) {
    return []
  }
  return value.images
    .filter((item: Partial<AgentToolImageResult>) => typeof item?.url === 'string' && item.url.trim())
    .map((item: AgentToolImageResult) => item)
}

export function formatAgentToolDetail(value: any) {
  if (value == null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value.output === 'string' && Object.keys(value).length <= 5) {
    const lines = [
      value.command ? `$ ${value.command}` : '',
      typeof value.exit_code !== 'undefined' ? `exit_code: ${value.exit_code}` : '',
      typeof value.duration_ms !== 'undefined' ? `duration_ms: ${value.duration_ms}` : '',
      '',
      value.output,
    ].filter((line) => line !== null)
    return lines.join('\n').trim()
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatAgentToolDuration(toolCall: AgentToolCall) {
  if (!toolCall.created_at || !toolCall.updated_at) {
    return ''
  }
  const started = new Date(toolCall.created_at).getTime()
  const ended = new Date(toolCall.updated_at).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return ''
  }
  const diff = ended - started
  if (diff < 1000) {
    return `${diff}ms`
  }
  return `${(diff / 1000).toFixed(1)}s`
}

function normalizeAgentTaskStepStatus(status?: string): AgentTaskStep['status'] {
  if (status === 'failed') {
    return 'failed'
  }
  if (status === 'running') {
    return 'running'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'pending'
}

function formatAgentRunLogEvent(
  event: AgentEvent,
  busy: boolean,
  completedModelTurns: Set<number>,
  locale: AgentTimelineLocale,
): AgentRunLogItem | null {
  const status = normalizeAgentEventStatus(event, busy, completedModelTurns)
  const title = formatAgentRunLogEventTitle(event, status, locale)
  if (!title) {
    return null
  }
  return {
    key: `event-${event.id}`,
    kind: event.event_type === 'response.completed' ? 'final' : 'event',
    title,
    detail: formatAgentRunLogEventDetail(event, status, locale),
    status,
    payload: formatAgentRunLogEventPayload(event),
    createdAt: event.created_at,
  }
}

function normalizeAgentEventStatus(
  event: AgentEvent,
  busy: boolean,
  completedModelTurns: Set<number>,
): AgentTaskStep['status'] {
  const turn = agentEventTurn(event)
  if (
    turn > 0
    && completedModelTurns.has(turn)
    && (
      event.event_type === 'model.turn.started'
      || event.event_type === 'model.delta'
      || event.event_type === 'model.tool_call.delta'
    )
  ) {
    return 'completed'
  }
  if (event.event_type === 'task.started' && !busy) {
    return 'completed'
  }
  if ((event.event_type === 'model.delta' || event.event_type === 'model.tool_call.delta') && !busy) {
    return 'completed'
  }
  const normalized = normalizeAgentTaskStepStatus(event.status)
  if (!busy && normalized === 'running') {
    return 'completed'
  }
  return normalized
}

function formatAgentRunLogEventTitle(
  event: AgentEvent,
  status: AgentTaskStep['status'],
  locale: AgentTimelineLocale,
) {
  const dict = getAgentTimelineDict(locale)
  if (event.event_type === 'task.started') {
    return status === 'running' ? dict.event.understandingTask : dict.event.taskUnderstood
  }
  if (event.event_type === 'skill.enabled') {
    return dict.event.enableSkills
  }
  if (event.event_type === 'prompt.sent') {
    return dict.event.sendModelRequest
  }
  if (event.event_type === 'model.turn.started') {
    return status === 'running' ? dict.event.callingBackend : dict.event.backendCalled
  }
  if (event.event_type === 'model.delta') {
    return status === 'running' ? dict.event.backendStreaming : dict.event.backendReturned
  }
  if (event.event_type === 'model.tool_call.delta') {
    const toolName = typeof event.data?.tool_name === 'string' ? event.data.tool_name : ''
    return toolName
      ? dict.event.generatingToolArgs(getAgentToolDisplayName(toolName, locale))
      : dict.event.generatingToolArgsAnon
  }
  if (event.event_type === 'model.tool_call.ready') {
    const toolName = typeof event.data?.tool_name === 'string' ? event.data.tool_name : ''
    return toolName
      ? dict.event.toolCallGenerated(getAgentToolDisplayName(toolName, locale))
      : dict.event.toolCallGeneratedAnon
  }
  if (event.event_type === 'model.turn.completed') {
    return dict.event.backendTurnCompleted
  }
  if (event.event_type === 'response.completed') {
    return dict.event.finalizeResponse
  }
  if (event.event_type === 'task.failed') {
    return event.label || dict.event.taskFailed
  }
  return event.label || event.message || event.event_type
}

function formatAgentRunLogEventDetail(
  event: AgentEvent,
  status: AgentTaskStep['status'] | undefined,
  locale: AgentTimelineLocale,
) {
  const dict = getAgentTimelineDict(locale)
  if (event.event_type === 'skill.enabled' && Array.isArray(event.data?.skills)) {
    const names = event.data.skills
      .map((skill: Partial<AgentSkillSpec>) => skill?.name)
      .filter((name: unknown): name is string => typeof name === 'string' && Boolean(name.trim()))
    if (names.length) {
      return names.join(', ')
    }
  }
  if (event.event_type === 'prompt.sent') {
    const model = typeof event.data?.model_id === 'string' && event.data.model_id.trim()
      ? event.data.model_id
      : dict.event.currentModel
    return `${model} · ${event.data?.native_tool_loop ? dict.event.nativeToolLoop : dict.event.standardChat}`
  }
  if (event.event_type === 'model.turn.started') {
    const turn = agentEventTurn(event)
    if (turn > 0 && status === 'completed') {
      return dict.event.modelTurnFinished(turn)
    }
    return event.message || (turn > 0 ? dict.event.requestingModelTurn(turn) : dict.event.requestingModel)
  }
  if (event.event_type === 'model.delta') {
    const chars = typeof event.data?.chars === 'number'
      ? event.data.chars
      : Array.from(String(event.data?.preview || '')).length
    return chars ? dict.event.receivedChars(chars) : dict.event.waitingBackendContent
  }
  if (event.event_type === 'model.tool_call.delta' || event.event_type === 'model.tool_call.ready') {
    const args = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
    return compactAgentRunDetail(args || event.message || '', locale)
  }
  if (event.event_type === 'model.turn.completed') {
    const toolCount = typeof event.data?.tool_calls === 'number' ? event.data.tool_calls : 0
    const contentChars = typeof event.data?.content_chars === 'number' ? event.data.content_chars : 0
    if (toolCount > 0) {
      return dict.event.modelRequestedNTools(toolCount)
    }
    if (contentChars > 0) {
      return dict.event.modelReturnedChars(contentChars)
    }
    return event.message || dict.event.thisTurnCompleted
  }
  return compactAgentRunDetail(event.message || event.label || '', locale)
}

function agentEventTurn(event: AgentEvent) {
  const raw = event.data?.turn
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function formatAgentRunLogEventPayload(event: AgentEvent) {
  return {
    type: event.event_type,
    stage: event.stage,
    status: event.status,
    label: event.label,
    message: event.message,
    data: event.data,
    created_at: event.created_at,
  }
}

function formatAgentToolRunTitle(toolCall: AgentToolCall, locale: AgentTimelineLocale) {
  const dict = getAgentTimelineDict(locale)
  const label = getAgentToolActionLabel(toolCall.tool_name, locale)
  if (toolCall.status === 'running') {
    return dict.tool.inProgress(label)
  }
  if (toolCall.status === 'failed') {
    return dict.tool.failed(label)
  }
  if (toolCall.status === 'completed') {
    return dict.tool.completed(label)
  }
  return label
}

function formatAgentToolRunDetail(toolCall: AgentToolCall, locale: AgentTimelineLocale) {
  const dict = getAgentTimelineDict(locale)
  if (toolCall.error_message) {
    return formatAgentErrorSummary(toolCall.error_message, locale)
  }
  const input = toolCall.input_data || {}
  const output = toolCall.output_data || {}
  if (toolCall.tool_name === 'shell_exec' && input.command) {
    return `$ ${input.command}`
  }
  {
    const mcp = parseMcpToolName(toolCall.tool_name)
    if (mcp) {
      const text = typeof output.text === 'string' ? output.text.trim() : ''
      if (text) {
        return text.length > 180 ? `${text.slice(0, 180)}…` : text
      }
      return `${mcp.server} · ${mcp.tool}`
    }
  }
  if ((toolCall.tool_name === 'web_search' || toolCall.tool_name === 'image_search') && input.query) {
    return String(input.query)
  }
  if (toolCall.tool_name === 'web_fetch' && Array.isArray(input.urls)) {
    return compactAgentRunDetail(input.urls.join(', '), locale)
  }
  if (
    (toolCall.tool_name === 'document_read'
      || toolCall.tool_name === 'document_write'
      || toolCall.tool_name === 'document_search')
    && (input.path || input.query || output.path)
  ) {
    if (toolCall.tool_name === 'document_write') {
      return `@ ${String(output.path || input.path)}`
    }
    return String(input.path || input.query)
  }
  if (toolCall.tool_name === 'apply_patch') {
    const ops = Array.isArray(output.file_ops) ? output.file_ops : []
    if (ops.length) {
      const paths = ops.map((op: any) => String(op?.path || '')).filter(Boolean).slice(0, 2)
      const more = ops.length > paths.length ? ` (+${ops.length - paths.length})` : ''
      return paths.join(', ') + more
    }
    if (typeof input.patch === 'string') {
      return compactAgentRunDetail(input.patch, locale)
    }
  }
  if (toolCall.tool_name === 'file_search') {
    if (input.query) {
      return String(input.query)
    }
  }
  if (toolCall.tool_name === 'fs_copy') {
    if ((output.src || input.src) && (output.dst || input.dst)) {
      return `${String(output.src || input.src)} → ${String(output.dst || input.dst)}`
    }
  }
  if (toolCall.tool_name === 'fs_list') {
    const count = Number(output.count) || 0
    const path = String(output.path || input.path || '/')
    return count ? `${path} · ${dict.tool.nEntries(count)}` : path
  }
  if (output.path || input.path || input.title) {
    return String(output.path || input.path || input.title)
  }
  if (Array.isArray(output.results)) {
    return dict.tool.nResults(output.results.length)
  }
  if (Array.isArray(output.images)) {
    return dict.tool.nImages(output.images.length)
  }
  return compactAgentRunDetail(
    formatAgentToolPayload(output, locale) || formatAgentToolPayload(input, locale),
    locale,
  )
}

function extractAgentErrorMessage(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) {
    return ''
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return ''
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const nested = extractAgentErrorMessage(JSON.parse(trimmed), depth + 1)
        if (nested) {
          return nested
        }
      } catch {
        // Keep the original text when the payload only resembles JSON.
      }
    }
    return trimmed
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractAgentErrorMessage(item, depth + 1)
      if (nested) {
        return nested
      }
    }
    return ''
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['message', 'detail', 'reason', 'error_description', 'error']) {
      const nested = extractAgentErrorMessage(record[key], depth + 1)
      if (nested) {
        return nested
      }
    }
  }
  return ''
}

export function formatAgentErrorSummary(
  value: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const extracted = extractAgentErrorMessage(value) || value
  const firstUsefulBlock = extracted
    .split(/\n\s*(?:at\s|stack(?:trace)?\s*:|goroutine\s|caused by\s*:)/i, 1)[0]
  const normalized = sanitizeAgentVisibleDetail(firstUsefulBlock, locale)
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:error|axioserror)\s*:\s*/i, '')
    .replace(/^\s*tool\s+(?:call|execution)\s+failed\s*[:\-]?\s*/i, '')
    .replace(/^\s*(?:error|axioserror)\s*:\s*/i, '')
    .replace(/^\s*rpc error\s*:\s*code\s*=\s*\w+\s*desc\s*=\s*/i, '')
    .replace(/\s*(?:trace|request|correlation)[-_ ]?id\s*[:=]\s*\S+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return getAgentTimelineDict(locale).status.failed
  }
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized
}

function compactAgentRunDetail(value: string, locale: AgentTimelineLocale) {
  const normalized = sanitizeAgentVisibleDetail(value, locale).replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized
}

function sanitizeAgentVisibleDetail(value: string, locale: AgentTimelineLocale) {
  const dict = getAgentTimelineDict(locale)
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }
  const looksLikeInternalBrowserContinuation =
    /^Continue the current .* in the desktop browser\./i.test(text) ||
    text.includes('The desktop browser has already attempted to open the exact search results page') ||
    text.includes('Do not ask me to type the site search manually') ||
    text.includes('Use the current browser page as the source page') ||
    text.includes('If the page is usable, extract the visible records from this page and complete the write.')

  if (looksLikeInternalBrowserContinuation) {
    if (/\b(write|table|record)\b/i.test(text)) {
      return dict.sanitize.continueAndWrite
    }
    return dict.sanitize.continueDefault
  }

  return text
}

function safeAgentTime(value: string) {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}
