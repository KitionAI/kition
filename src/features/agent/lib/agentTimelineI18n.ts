import i18next from 'i18next'
import { DEFAULT_LOCALE, resolveLocale, type Locale } from '@/i18n/types'
import type enAgent from '@/i18n/locales/en-US/agent.json'

export type AgentTimelineLocale = Locale
export const DEFAULT_AGENT_TIMELINE_LOCALE = DEFAULT_LOCALE

export function resolveAgentTimelineLocale(value: string | undefined | null): AgentTimelineLocale {
  return resolveLocale(value)
}

type ToolLabelMap = Record<string, string>

type AgentTimelineDict = {
  status: { failed: string }
  sections: {
    tool: string
    input: string
    output: string
    error: string
    status: string
    data: string
    path: string
    title: string
    preview: string
    noDetail: string
  }
  model: {
    titlePlanning: string
    titleProcessing: string
    detailPlanning: string
    detailProcessing: (tool: string) => string
    expandedPlanning: string
    expandedProcessing: (tool: string) => string
  }
  activity: {
    thinking: string
    completionUnknown: string
    interruptedDetail: string
    stopped: string
  }
  event: {
    callingBackend: string
    backendCalled: string
    backendTurnCompleted: string
    taskFailed: string
    taskCompleted: string
    stepLimit: string
    modelTurnFinished: (turn: number) => string
    requestingModelTurn: (turn: number) => string
    modelRequestedNTools: (count: number) => string
    modelReturnedChars: (chars: number) => string
    thisTurnCompleted: string
    reconnecting: (attempt: number, maxRetries: number) => string
    reconnectingNow: string
    reconnectingInSeconds: (seconds: number) => string
    reconnectReason: Record<string, string>
  }
  tool: {
    inProgress: (label: string) => string
    failed: (label: string) => string
    completed: (label: string) => string
    nResults: (count: number) => string
    nImages: (count: number) => string
    nEntries: (count: number) => string
  }
  artifact: { title: string }
  final: { streaming: string }
  toolDisplayName: ToolLabelMap
  toolActionLabel: ToolLabelMap
  mcpDisplayPrefix: string
  mcpActionTemplate: (server: string, tool: string) => string
}


export function getAgentTimelineDict(locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE): AgentTimelineDict {
  const t = i18next.getFixedT(locale, 'agent')
  const strings = t('timeline', { returnObjects: true }) as typeof enAgent.timeline
  return {
    ...strings,
    model: {
      ...strings.model,
      detailProcessing: (tool) => t('timeline.model.detailProcessing', { tool }),
      expandedProcessing: (tool) => t('timeline.model.expandedProcessing', { tool }),
    },
    event: {
      ...strings.event,
      modelTurnFinished: (turn) => t('timeline.event.modelTurnFinished', { turn }),
      requestingModelTurn: (turn) => t('timeline.event.requestingModelTurn', { turn }),
      modelRequestedNTools: (count) => t('timeline.event.modelRequestedNTools', { count }),
      modelReturnedChars: (chars) => t('timeline.event.modelReturnedChars', { chars }),
      reconnecting: (attempt, maxRetries) => t('timeline.event.reconnecting', { attempt, maxRetries }),
      reconnectingInSeconds: (seconds) => t('timeline.event.reconnectingInSeconds', { seconds, count: seconds }),
    },
    tool: {
      ...strings.tool,
      inProgress: (label) => t('timeline.tool.inProgress', { label }),
      failed: (label) => t('timeline.tool.failed', { label }),
      completed: (label) => t('timeline.tool.completed', { label }),
      nResults: (count) => t('timeline.tool.nResults', { count }),
      nImages: (count) => t('timeline.tool.nImages', { count }),
      nEntries: (count) => t('timeline.tool.nEntries', { count }),
    },
    mcpActionTemplate: (server, tool) => t('timeline.mcpActionTemplate', { server, tool }),
  }
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName) {
    return null
  }
  const idx = toolName.indexOf('__')
  if (idx <= 0 || idx + 2 >= toolName.length) {
    return null
  }
  return { server: toolName.slice(0, idx), tool: toolName.slice(idx + 2) }
}

export function getAgentToolDisplayName(
  toolName: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (dict.toolDisplayName[toolName]) {
    return dict.toolDisplayName[toolName]
  }
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return `${dict.mcpDisplayPrefix} · ${mcp.server} · ${mcp.tool.replaceAll('_', ' ')}`
  }
  return toolName.replaceAll('_', ' ')
}

export function getAgentToolActionLabel(
  toolName: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (dict.toolActionLabel[toolName]) {
    return dict.toolActionLabel[toolName]
  }
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return dict.mcpActionTemplate(mcp.server, mcp.tool.replaceAll('_', ' '))
  }
  return getAgentToolDisplayName(toolName, locale)
}
