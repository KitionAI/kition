import type { AgentBrowserContext } from '@/api/agent'
import {
  ensureBrowserSessionWindow,
  extractBrowserPageContext,
  type BrowserPageContext,
  type BrowserSessionProvider,
} from '@/services/desktop'
import type { AgentWebTarget } from './agentBrowserIntent'
import {
  buildActiveBrowserTabContext,
  mapBrowserPageContextToAgentBrowserContext,
} from './agentTurnContext'

const DEFAULT_CONTEXT_ATTEMPTS = 8
const DEFAULT_RETRY_DELAY_MS = 500

function hasUsablePageData(context: BrowserPageContext) {
  return Boolean(
    context.extracted_entities?.length ||
    context.content_blocks?.length ||
    context.links?.length ||
    String(context.visible_text_preview || '').trim() ||
    String(context.content_text_preview || '').trim() ||
    String(context.main_content_html || '').trim() ||
    String(context.html_snapshot || '').trim(),
  )
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })
}

export async function preflightAgentBrowserContext(input: {
  target: AgentWebTarget
  provider?: BrowserSessionProvider
  attempts?: number
  retryDelayMs?: number
}): Promise<AgentBrowserContext | undefined> {
  const provider = input.provider || 'generic-web'
  const status = await ensureBrowserSessionWindow({
    provider,
    host: input.target.host,
    url: input.target.url,
  })
  const fallback = buildActiveBrowserTabContext({
    provider,
    host: input.target.host,
    url: status.page_url || input.target.url,
    title: status.page_title,
  })
  const attempts = Math.max(1, input.attempts ?? DEFAULT_CONTEXT_ATTEMPTS)
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  let latestContext: BrowserPageContext | undefined

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      latestContext = await extractBrowserPageContext({
        provider,
        host: input.target.host,
      })
      if (hasUsablePageData(latestContext)) {
        break
      }
    } catch {
      if (attempt === attempts - 1) {
        return fallback
      }
    }
    if (attempt < attempts - 1 && retryDelayMs > 0) {
      await wait(retryDelayMs)
    }
  }

  return mapBrowserPageContextToAgentBrowserContext(latestContext, provider) || fallback
}
