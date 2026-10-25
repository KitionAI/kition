import { FileTextIcon as FileText, FileTypeCornerIcon as FileType2, FileSpreadsheetIcon as FileSpreadsheet, EarthIcon as Globe2, ImageIcon, PresentationIcon as Presentation, TerminalIcon as Terminal, WrenchIcon as Wrench, type IconComponent } from '@kition/tessera-icons/react'
import type { AgentRunLogItem, AgentTaskStep } from './agentTimelineTypes'
import { compactAgentRunDetail, sanitizeAgentVisibleDetail } from './agentTimelineText'
import {
  DEFAULT_AGENT_TIMELINE_LOCALE,
  type AgentTimelineLocale,
  getAgentTimelineDict,
  getAgentToolActionLabel,
  getAgentToolDisplayName,
  parseMcpToolName,
} from './agentTimelineI18n'
import type { AgentLiveAttempt, AgentToolRun, AgentTurnView } from './agentSessionView'

export type { AgentTimelineLocale } from './agentTimelineI18n'
export { resolveAgentTimelineLocale } from './agentTimelineI18n'

export type { AgentRunLogItem } from './agentTimelineTypes'

export type AgentToolImageResult = {
  url: string
  preview_url?: string
  thumb_url?: string
  title?: string
  alt?: string
  page_url?: string
  source?: string
}

/** Tool fields read as a loose record, as the formatters below expect. */
type Fields = Record<string, any>

function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
}

function iso(ms: number) {
  return new Date(ms).toISOString()
}

/** The run log status of a tool run; a paused command shows its approval decision. */
function runStatus(run: AgentToolRun, turn: AgentTurnView, busy: boolean): AgentTaskStep['status'] {
  if (run.status === 'running') return busy ? 'running' : 'pending'
  if (run.status === 'awaiting_approval') {
    const decided = turn.approval?.callId === run.callId ? turn.approval.decided : undefined
    if (!decided) return 'pending'
    return decided === 'allowed-once' ? 'completed' : 'failed'
  }
  return run.status
}

function toolItem(run: AgentToolRun, turn: AgentTurnView, busy: boolean, locale: AgentTimelineLocale): AgentRunLogItem {
  const status = runStatus(run, turn, busy)
  return {
    key: `tool-${run.callId}`,
    kind: 'tool',
    title: formatAgentToolRunTitle(run.name, status, locale),
    detail: formatAgentToolRunDetail(run, locale),
    status,
    toolName: run.name,
    payload: {
      tool: run.name,
      status: run.status,
      input: run.arguments,
      output: run.output,
      error: run.error,
    },
    createdAt: iso(run.startedAt),
  }
}

/** Files the turn delivered that no tool row already names by its output path. */
function deliverableItems(turn: AgentTurnView, locale: AgentTimelineLocale): AgentRunLogItem[] {
  const dict = getAgentTimelineDict(locale)
  const toolPaths = new Set(turn.toolRuns
    .map((run) => fields(run.output).path)
    .filter((path): path is string => typeof path === 'string' && Boolean(path)))
  return turn.deliverables
    .filter((file) => !toolPaths.has(file.path))
    .map((file) => {
      const run = turn.toolRuns.find((candidate) => candidate.callId === file.callId)
      return {
        key: `artifact-${file.callId}-${file.path}`,
        kind: 'artifact' as const,
        title: dict.artifact.title,
        detail: file.path,
        status: 'completed' as const,
        payload: { path: file.path, title: file.description },
        createdAt: iso(run?.endedAt ?? run?.startedAt ?? turn.startedAt),
      }
    })
}

function retryItems(turn: AgentTurnView, busy: boolean, locale: AgentTimelineLocale): AgentRunLogItem[] {
  const dict = getAgentTimelineDict(locale)
  return turn.retries.map((retry) => {
    const later = turn.retries.some((other) => other.retryId === retry.retryId && other.retry > retry.retry)
    const step = turn.steps.find((candidate) => candidate.step === retry.step)
    const settled = later || Boolean(step?.message || step?.attemptError || turn.end)
    const seconds = Math.ceil(Math.max(0, retry.delayMs) / 1000)
    const delay = seconds > 0 ? dict.event.reconnectingInSeconds(seconds) : dict.event.reconnectingNow
    const reason = dict.event.reconnectReason[retry.failure.code] || ''
    return {
      key: `retry-${retry.retryId}-${retry.retry}`,
      kind: 'event' as const,
      title: dict.event.reconnecting(retry.retry, retry.maxRetries),
      detail: reason ? `${delay} · ${reason}` : delay,
      status: settled ? 'completed' as const : busy ? 'running' as const : 'pending' as const,
      payload: { message: retry.failure.message, data: retry.failure },
      createdAt: iso(retry.at),
    }
  })
}

/** Model steps and replies, shown in debug mode only. */
function stepItems(turn: AgentTurnView, busy: boolean, locale: AgentTimelineLocale): AgentRunLogItem[] {
  const dict = getAgentTimelineDict(locale)
  return turn.steps.flatMap((step) => {
    const settled = Boolean(step.message || step.attemptError || turn.end)
    const items: AgentRunLogItem[] = [{
      key: `step-${step.step}`,
      kind: 'event',
      title: settled || !busy ? dict.event.backendCalled : dict.event.callingBackend,
      detail: settled ? dict.event.modelTurnFinished(step.step) : dict.event.requestingModelTurn(step.step),
      status: settled ? 'completed' : busy ? 'running' : 'pending',
      payload: { message: step.attemptError, data: { step: step.step } },
      createdAt: iso(step.startedAt),
    }]
    const message = step.message
    if (message) {
      const chars = Array.from(message.content.trim()).length
      items.push({
        key: `message-${step.step}`,
        kind: 'event',
        title: dict.event.backendTurnCompleted,
        detail: message.toolCallCount > 0
          ? dict.event.modelRequestedNTools(message.toolCallCount)
          : chars > 0 ? dict.event.modelReturnedChars(chars) : dict.event.thisTurnCompleted,
        status: 'completed',
        payload: { message: message.model, data: { model: message.model, stop_reason: message.stopReason } },
        createdAt: iso(message.at),
      })
    }
    return items
  })
}

/** The time of the turn's last known event. */
function lastKnownAt(turn: AgentTurnView) {
  return Math.max(
    turn.startedAt,
    ...turn.steps.flatMap((step) => [step.startedAt, step.endedAt ?? 0, step.message?.at ?? 0]),
    ...turn.toolRuns.flatMap((run) => [run.startedAt, run.endedAt ?? 0]),
    ...turn.retries.map((retry) => retry.at),
  )
}

/** How the turn ended, or that its outcome is unknown. */
function outcomeItem(turn: AgentTurnView, locale: AgentTimelineLocale): AgentRunLogItem | null {
  const dict = getAgentTimelineDict(locale)
  if (!turn.end) {
    return turn.interrupted ? {
      key: 'outcome', kind: 'event', title: dict.activity.completionUnknown,
      detail: dict.activity.interruptedDetail, status: 'pending', createdAt: iso(lastKnownAt(turn)),
    } : null
  }
  const at = iso(turn.end.at)
  switch (turn.end.reason) {
    case 'completed':
      return { key: 'outcome', kind: 'event', title: dict.event.taskCompleted, status: 'completed', createdAt: at }
    case 'cancelled':
      return { key: 'outcome', kind: 'event', title: dict.activity.stopped, detail: dict.activity.stopped, status: 'pending', createdAt: at }
    case 'awaiting-approval':
      return null
    default: {
      const error = turn.end.reason === 'step-limit' ? dict.event.stepLimit : turn.end.error
      return {
        key: 'outcome', kind: 'event', title: dict.event.taskFailed,
        detail: error ? formatAgentErrorSummary(error, locale) : undefined,
        status: 'failed', payload: { message: error }, createdAt: at,
      }
    }
  }
}

/** The run log of one turn: its tool runs, delivered files, retries, and outcome. */
export function buildAgentRunLogItems({
  turn,
  live = null,
  busy,
  debug = false,
  locale = DEFAULT_AGENT_TIMELINE_LOCALE,
}: {
  turn: AgentTurnView
  live?: AgentLiveAttempt | null
  busy: boolean
  debug?: boolean
  locale?: AgentTimelineLocale
}): AgentRunLogItem[] {
  const dict = getAgentTimelineDict(locale)
  const items: AgentRunLogItem[] = [
    ...turn.toolRuns.map((run) => toolItem(run, turn, busy, locale)),
    ...deliverableItems(turn, locale),
    ...retryItems(turn, busy, locale),
    ...(debug ? stepItems(turn, busy, locale) : []),
  ]
  const outcome = outcomeItem(turn, locale)
  if (outcome) items.push(outcome)

  const streamingText = live?.turn === turn.turn ? live.text : ''
  if (streamingText) {
    items.push({
      key: 'final-streaming',
      kind: 'final',
      title: dict.final.streaming,
      detail: compactAgentRunDetail(streamingText, locale),
      status: 'running',
      payload: { preview: compactAgentRunDetail(streamingText, locale) },
      createdAt: new Date().toISOString(),
    })
  }

  if (busy && !items.some((item) => item.status === 'running')) {
    const latestTool = turn.toolRuns.at(-1)
    const toolLabel = latestTool ? getAgentToolDisplayName(latestTool.name, locale) : ''
    items.push({
      key: 'model-thinking',
      kind: 'model',
      title: latestTool ? dict.model.titleProcessing : dict.model.titlePlanning,
      detail: latestTool ? dict.model.detailProcessing(toolLabel) : dict.model.detailPlanning,
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

export function formatAgentRunLogExpandedDetail(
  item: AgentRunLogItem,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (item.payload == null) {
    return item.detail || ''
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
    return rows.length ? rows.join('\n\n') : dict.sections.noDetail
  }
  if (item.kind === 'event') {
    const rows: string[] = []
    if (item.payload.message) {
      rows.push(`${dict.sections.status}\n${String(item.payload.message)}`)
    }
    if (item.payload.data) {
      rows.push(`${dict.sections.data}\n${formatAgentToolDetail(item.payload.data)}`)
    }
    return rows.length ? rows.join('\n\n') : item.detail || dict.sections.noDetail
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
    return rows.length ? rows.join('\n\n') : dict.sections.noDetail
  }
  if (item.kind === 'final') {
    if (typeof item.payload.preview === 'string' && item.payload.preview.trim()) {
      return `${dict.sections.preview}\n${item.payload.preview}`
    }
    return item.detail || dict.sections.noDetail
  }
  return item.detail || dict.sections.noDetail
}

export function resolveAgentToolIcon(toolName: string, outputPath?: string): IconComponent {
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

export function extractAgentToolImageResults(value: any): AgentToolImageResult[] {
  if (!value || !Array.isArray(value.images)) {
    return []
  }
  return value.images
    .filter((item: Partial<AgentToolImageResult>) => typeof item?.url === 'string' && item.url.trim())
    .map((item: AgentToolImageResult) => item)
}

function formatAgentToolPayload(
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

function formatAgentToolDetail(value: any) {
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

function formatAgentToolRunTitle(name: string, status: AgentTaskStep['status'], locale: AgentTimelineLocale) {
  const dict = getAgentTimelineDict(locale)
  const label = getAgentToolActionLabel(name, locale)
  if (status === 'running') {
    return dict.tool.inProgress(label)
  }
  if (status === 'failed') {
    return dict.tool.failed(label)
  }
  if (status === 'completed') {
    return dict.tool.completed(label)
  }
  return label
}

function formatAgentToolRunDetail(run: AgentToolRun, locale: AgentTimelineLocale) {
  const dict = getAgentTimelineDict(locale)
  if (run.error) {
    return formatAgentErrorSummary(run.error, locale)
  }
  const input = fields(run.arguments)
  const output = fields(run.output)
  if (run.name === 'shell_exec' && input.command) {
    return `$ ${input.command}`
  }
  {
    const mcp = parseMcpToolName(run.name)
    if (mcp) {
      const text = typeof output.text === 'string' ? output.text.trim() : ''
      if (text) {
        return text.length > 180 ? `${text.slice(0, 180)}…` : text
      }
      return `${mcp.server} · ${mcp.tool}`
    }
  }
  if ((run.name === 'web_search' || run.name === 'image_search') && input.query) {
    return String(input.query)
  }
  if (run.name === 'web_fetch' && Array.isArray(input.urls)) {
    return compactAgentRunDetail(input.urls.join(', '), locale)
  }
  if (
    (run.name === 'document_read'
      || run.name === 'document_write'
      || run.name === 'document_search')
    && (input.path || input.query || output.path)
  ) {
    if (run.name === 'document_write') {
      return `@ ${String(output.path || input.path)}`
    }
    return String(input.path || input.query)
  }
  if (run.name === 'apply_patch') {
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
  if (run.name === 'file_search') {
    if (input.query) {
      return String(input.query)
    }
  }
  if (run.name === 'fs_copy') {
    if ((output.src || input.src) && (output.dst || input.dst)) {
      return `${String(output.src || input.src)} → ${String(output.dst || input.dst)}`
    }
  }
  if (run.name === 'fs_list') {
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

function safeAgentTime(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}
