import type { AgentBrowserContext, AgentEvent } from '@/api/agent'
import {
  extractBrowserPageContext,
  type BrowserPageContextRequest,
  type BrowserSessionProvider,
} from '@/services/desktop'
import { MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS } from './agentBrowserIntent'
import { mapBrowserPageContextToAgentBrowserContext } from './agentTurnContext'

export type AgentBrowserOpenRequest = {
  action: string
  provider?: string
  adapter?: string
  command?: string
  entityType?: string
  host?: string
  url?: string
  query?: string
  message?: string
  autoContinue?: boolean
  autoContinueAttempt?: number
  autoContinueExhausted?: boolean
  originalRequest?: string
}

type ActiveBrowserTarget = {
  provider: BrowserSessionProvider
  profileId?: string
  host?: string
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readAttempt(value: unknown) {
  const attempt = Number(value)
  return Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : undefined
}

export function readBrowserOpenRequest(event: AgentEvent): AgentBrowserOpenRequest {
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>
  return {
    action: readOptionalString(data.action) || 'open_embedded_browser',
    provider: readOptionalString(data.provider),
    adapter: readOptionalString(data.adapter),
    command: readOptionalString(data.command),
    entityType: readOptionalString(data.entity_type) || readOptionalString(data.entityType),
    host: readOptionalString(data.host),
    url: readOptionalString(data.url),
    query: readOptionalString(data.query),
    autoContinue: data.client_auto_continue === true,
    autoContinueAttempt: readAttempt(data.client_auto_continue_attempt),
    autoContinueExhausted: data.client_auto_continue_exhausted === true,
    originalRequest: readOptionalString(data.client_original_request),
    message:
      readOptionalString(event.message) ||
      'The agent needs you to open the page in the browser before continuing.',
  }
}

export function findLatestBrowserContinuationRequest(events: AgentEvent[]) {
  let latest: { eventId: number; request: AgentBrowserOpenRequest } | null = null
  let previousAutoRequest: AgentBrowserOpenRequest | null = null

  for (const event of events) {
    if (event.event_type !== 'browser.open_required') {
      continue
    }
    const request = readBrowserOpenRequest(event)
    if (request.autoContinue || request.autoContinueExhausted) {
      latest = { eventId: event.id, request }
      previousAutoRequest = request
      continue
    }
    if (!previousAutoRequest?.autoContinue || previousAutoRequest.autoContinueExhausted) {
      continue
    }

    const nextAttempt = (previousAutoRequest.autoContinueAttempt || 1) + 1
    const exhausted = nextAttempt > MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS
    const recoveredRequest: AgentBrowserOpenRequest = {
      ...request,
      autoContinue: !exhausted,
      autoContinueAttempt: exhausted
        ? MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS
        : nextAttempt,
      autoContinueExhausted: exhausted,
      originalRequest: previousAutoRequest.originalRequest,
    }
    latest = { eventId: event.id, request: recoveredRequest }
    previousAutoRequest = recoveredRequest
  }

  return latest
}

export function buildAgentBrowserPageContextRequest(
  target: ActiveBrowserTarget,
  request: AgentBrowserOpenRequest,
): BrowserPageContextRequest {
  return {
    provider: target.provider,
    profile_id: target.profileId,
    host: target.host || request.host,
    adapter: request.adapter,
    command: request.command,
    query: request.query,
    entity_type: request.entityType,
  }
}

export async function extractAgentBrowserContinuationContext(input: {
  target: ActiveBrowserTarget
  request: AgentBrowserOpenRequest
}): Promise<AgentBrowserContext | undefined> {
  const pageContext = await extractBrowserPageContext(
    buildAgentBrowserPageContextRequest(input.target, input.request),
  )
  return mapBrowserPageContextToAgentBrowserContext(
    pageContext,
    input.target.provider,
    {
      action: input.request.action,
      adapter: input.request.adapter,
      command: input.request.command,
      entityType: input.request.entityType,
      host: input.request.host || input.target.host,
    },
  )
}
