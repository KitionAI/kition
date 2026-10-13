import type { KitsBridgeDocumentApplyParams, KitsBridgeDocumentApplyResult, KitsBridgeDocumentReadResult } from '@/api/kits'
import { runtimeBridge, type BridgeChannel, type BridgeTransport } from '@/services/runtimeBridge'

/**
 * This window's end of the document bridge: the agent's edits to a Markdown
 * document open here go to the document's session instead of the file, so
 * they show at once as the agent's edit and the session saves them.
 *
 * Each open document session registers itself; the window announces the open
 * paths to the runtime (`documents.open`) and answers its requests on the
 * shared bridge stream:
 *
 * - `document/read { path }` → `{ open: true, content }` (the live text,
 *   unsaved edits included) or `{ open: false }`;
 * - `document/apply { path, content, tool, turnId? }` → `{ applied: true,
 *   content }` (the file content after the session saved) or
 *   `{ applied: false, reason }` (`not-open` when no session has the path).
 *
 * The runtime writes the file itself when the window refuses or does not
 * answer in time. This module only routes; what applying means is the
 * session's business.
 */

/** Who made an agent edit, as `document/apply` reports it. */
type DocumentApplyMeta = { tool: string; turnId?: string }

type DocumentApplyOutcome = { applied: boolean; content?: string; reason?: string }

/** What an open document session offers the agent. */
export type OpenDocumentHandlers = {
  /** The live text, unsaved edits included. */
  read: () => string
  /** Applies the agent's whole new text as its difference and saves; answers the saved file content. */
  apply: (content: string, meta: DocumentApplyMeta) => Promise<DocumentApplyOutcome>
}

function normalize(path: string) {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function createDocumentAgentBridge(transport: BridgeTransport) {
  const documents = new Map<string, OpenDocumentHandlers>()
  let close: (() => void) | null = null

  function announce() {
    transport.notify('documents.open', { paths: [...documents.keys()] })
  }

  async function apply(params: Record<string, unknown>): Promise<KitsBridgeDocumentApplyResult> {
    const request = params as Partial<KitsBridgeDocumentApplyParams>
    const handlers = documents.get(normalize(String(request.path ?? '')))
    if (!handlers) return { applied: false, reason: 'not-open' }
    if (typeof request.content !== 'string') return { applied: false, reason: 'the edit has no content' }
    const meta: DocumentApplyMeta = { tool: String(request.tool ?? '') }
    if (typeof request.turnId === 'string') meta.turnId = request.turnId
    let outcome: DocumentApplyOutcome
    try {
      outcome = await handlers.apply(request.content, meta)
    } catch (error) {
      return { applied: false, reason: errorText(error) || 'the edit failed' }
    }
    if (!outcome.applied) return { applied: false, reason: outcome.reason || 'refused' }
    return { applied: true, content: outcome.content ?? handlers.read() }
  }

  function read(params: Record<string, unknown>): KitsBridgeDocumentReadResult {
    const handlers = documents.get(normalize(String(params.path ?? '')))
    return handlers ? { open: true, content: handlers.read() } : { open: false }
  }

  const channel: BridgeChannel = {
    handles: (method) => method.startsWith('document/'),
    handle(method, params) {
      if (method === 'document/read') return read(params)
      if (method === 'document/apply') return apply(params)
      throw new Error(`unknown bridge method ${method}`)
    },
    ready: announce,
  }

  /** Makes an open document reachable by the agent; returns the function that withdraws it. */
  function registerOpenDocument(path: string, handlers: OpenDocumentHandlers) {
    const key = normalize(path)
    documents.set(key, handlers)
    close ??= transport.open(channel)
    announce()
    return () => {
      if (documents.get(key) !== handlers) return
      documents.delete(key)
      announce()
      if (documents.size) return
      close?.()
      close = null
    }
  }

  return { registerOpenDocument }
}

const windowBridge = createDocumentAgentBridge(runtimeBridge)

/** Makes a document open in this window reachable by the agent's edits; returns the function that withdraws it. */
export const registerOpenDocument = windowBridge.registerOpenDocument
