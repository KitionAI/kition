import type { AgentTimelineLocale } from './agentTimelineI18n'

export function compactAgentRunDetail(value: string, locale: AgentTimelineLocale) {
  const normalized = sanitizeAgentVisibleDetail(value, locale).replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized
}

export function sanitizeAgentVisibleDetail(value: string, _locale: AgentTimelineLocale) {
  return String(value || '').trim()
}

