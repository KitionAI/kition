const WEB_TARGET_PATTERN = /(?:https?:\/\/|www\.|\blocalhost(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+(?:\b|\/))/i

const BROWSER_ACTION_PATTERN = /\b(?:browse|browser|navigate|open|search|visit|view)\b/i
const FOLLOWUP_TASK_PATTERN = /\b(?:analyze|capture|check|click|collect|compare|copy|crawl|describe|download|extract|fetch|fill|gather|inspect|monitor|read|report|research|save|scrape|screenshot|submit|summarize|sync|upload|verify|write)\b/i
const EXPLICIT_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i
const BARE_WEB_TARGET_PATTERN = /(?:www\.[a-z0-9.-]+|localhost(?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+)(?:\/[^\s<>"'`]*)?/i

export type AgentBrowserIntent = {
  browserEnabled: boolean
  continueAfterOpen: boolean
}

export type AgentWebTarget = {
  host: string
  url: string
}

export function extractAgentWebTarget(content: string): AgentWebTarget | null {
  const prompt = String(content || '').trim()
  const rawTarget = (
    prompt.match(EXPLICIT_URL_PATTERN)?.[0] ||
    prompt.match(BARE_WEB_TARGET_PATTERN)?.[0] ||
    ''
  ).replace(/[),.;!?]+$/g, '')
  if (!rawTarget) {
    return null
  }

  try {
    const url = new URL(/^https?:\/\//i.test(rawTarget) ? rawTarget : `https://${rawTarget}`)
    return {
      host: url.hostname.replace(/^www\./i, ''),
      url: url.toString(),
    }
  } catch {
    return null
  }
}

export function analyzeAgentBrowserIntent(content: string): AgentBrowserIntent {
  const prompt = String(content || '').trim()
  const hasWebTarget = WEB_TARGET_PATTERN.test(prompt)
  const hasBrowserAction = BROWSER_ACTION_PATTERN.test(prompt)
  const hasFollowupTask = FOLLOWUP_TASK_PATTERN.test(prompt)
  const browserEnabled = hasWebTarget && (hasBrowserAction || hasFollowupTask)
  const continueAfterOpen = browserEnabled && hasFollowupTask

  return {
    browserEnabled,
    continueAfterOpen,
  }
}

export function buildBrowserAutoContinuePrompt(originalRequest: string) {
  const request = String(originalRequest || '').trim()
  return [
    'Continue the original request now that the requested page is open in the built-in browser.',
    'Use the current browser page and browser state to complete the remaining steps exactly as the user requested without asking them to repeat the task.',
    'Treat the original request as the source of truth. Do not invent extra output formats, fields, or actions.',
    'If the task requires a durable change, verify that change before reporting completion.',
    request ? `Original request: ${request}` : '',
  ].filter(Boolean).join(' ')
}

export function buildBrowserUnavailablePrompt(originalRequest: string) {
  const request = String(originalRequest || '').trim()
  return [
    'The built-in browser could not open or expose the requested page for the original task.',
    'Report this as a blocker now. Do not fabricate results, perform unrelated fallback actions, or claim the original task is complete.',
    request ? `Original request: ${request}` : '',
  ].filter(Boolean).join(' ')
}
