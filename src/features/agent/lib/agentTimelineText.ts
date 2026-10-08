import { getAgentTimelineDict, type AgentTimelineLocale } from './agentTimelineI18n'

export function compactAgentRunDetail(value: string, locale: AgentTimelineLocale) {
  const normalized = sanitizeAgentVisibleDetail(value, locale).replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized
}

export function sanitizeAgentVisibleDetail(value: string, locale: AgentTimelineLocale) {
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

