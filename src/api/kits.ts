/**
 * Kits: the bridge between the runtime's agent and the kit editors open in this window, and the
 * file writes those editors save through.
 */
import request from './request'
import { resolveApiURL } from '@/services/desktop'
import type {
  KitsBridgeChanged,
  KitsBridgeCommand,
  KitsBridgeDocument,
  KitsBridgeDocumentApplyParams,
  KitsBridgeDocumentApplyResult,
  KitsBridgeDocumentReadResult,
  KitsBridgeDraftInfo,
  KitsBridgeLiveDocument,
  KitsBridgeRunStep,
  KitsDraftComparison,
  KitsDraftDiscardResult,
  KitsDraftList,
  KitsDraftMergeResult,
  KitsHeadlessDraft,
} from './generated/kits'

export type { KitsDraftComparison, KitsHeadlessDraft }
export type { KitsBridgeChanged, KitsBridgeCommand, KitsBridgeDocument, KitsBridgeDocumentApplyParams, KitsBridgeDocumentApplyResult, KitsBridgeDocumentReadResult, KitsBridgeDraftInfo, KitsBridgeLiveDocument, KitsBridgeRunStep }

/**
 * Replaces a workspace file a kit edits with `bytes`; the in-page editors save through it. The
 * bytes are the request body as they are: wrapping them in a Blob would copy a file of up to
 * 2 GiB once more, and WebKit's network inspection (which the e2e specs read saves through)
 * does not report a Blob body.
 */
export function writeKitFile(path: string, bytes: Uint8Array) {
  return request.put('/v1/kits/files', bytes, {
    params: { path },
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 10 * 60_000,
    suppressErrorMessage: true,
  })
}

/** The bridge stream: the runtime's requests to this window's kit editors and open documents. */
export function kitBridgeURL() {
  return resolveApiURL('/v1/kits/bridge')
}

/** An answer to a bridge request, or a `kit.changed` or `documents.open` notification, from this window. */
export function postKitBridgeMessage(session: number, message: Record<string, unknown>) {
  return request.post('/v1/kits/bridge', message, { params: { session }, suppressErrorMessage: true })
}

/**
 * The drafts an agent keeps beside workspace files over `kition-kits-mcp --drafts` (Kit Standard
 * A27). Only the person merges or discards them (A14).
 */
export async function listKitDrafts(): Promise<KitsHeadlessDraft[]> {
  const answer = await request.get<KitsDraftList>('/v1/kits/drafts', { suppressErrorMessage: true })
  return Array.isArray(answer?.drafts) ? answer.drafts : []
}

/** What merging the draft of `path` would change; `previews` also renders both sides. */
export function compareKitDraft(path: string, previews = true) {
  return request.get<KitsDraftComparison>('/v1/kits/drafts/compare', { params: { path, previews }, timeout: 120_000, suppressErrorMessage: true })
}

/**
 * Writes the draft of `path` as the file. Refused with reason `stale` (409) when the file changed
 * since the draft forked, unless `overwrite`, which drops those edits.
 */
export function mergeKitDraft(path: string, overwrite = false) {
  return request.post<KitsDraftMergeResult>('/v1/kits/drafts/merge', { path, overwrite }, { timeout: 120_000, suppressErrorMessage: true })
}

/** Drops the draft of `path`; the file stays as it is. */
export function discardKitDraft(path: string) {
  return request.post<KitsDraftDiscardResult>('/v1/kits/drafts/discard', { path }, { suppressErrorMessage: true })
}

/** The runtime's reason for refusing a draft command (`stale`, `not-found`, a kit tool code). */
export function kitDraftRefusal(error: unknown): string | null {
  const body = (error as { response?: { data?: { data?: { reason?: unknown } } } })?.response?.data
  const reason = body?.data?.reason
  return typeof reason === 'string' ? reason : null
}
