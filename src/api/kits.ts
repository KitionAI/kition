/**
 * Kits: the bridge between the runtime's agent and the kit editors open in this window, the
 * file writes those editors save through, and the file grants they reach other files through.
 */
import request from './request'
import { resolveApiURL } from '@/services/desktop'
import type {
  KitsCreateFileRequest,
  KitsFileList,
  KitsFileStat,
  KitsGrantRequest,
  KitsGrantSession,
  KitsGrantSessionEnd,
  KitsGrantSessionRequest,
  KitsGrantSessionView,
  KitsWriteChunkResult,
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

export type { KitsDraftComparison, KitsFileStat, KitsGrantSessionView, KitsHeadlessDraft }
export type { KitsBridgeChanged, KitsBridgeCommand, KitsBridgeDocument, KitsBridgeDocumentApplyParams, KitsBridgeDocumentApplyResult, KitsBridgeDocumentReadResult, KitsBridgeDraftInfo, KitsBridgeLiveDocument, KitsBridgeRunStep }

/**
 * Writes `bytes` to a workspace file: with `document` (the document an in-page editor opened, and
 * `path` must be it) it saves that document; without, it makes a new file (a new document or an
 * export), and the runtime refuses to replace an existing one. The bytes are the request body as they are: wrapping them in a Blob would copy a file of up to
 * 2 GiB once more, and WebKit's network inspection (which the e2e specs read saves through)
 * does not report a Blob body.
 */
export function writeKitFile(path: string, bytes: Uint8Array, { document }: { document?: string } = {}) {
  return request.put('/v1/kits/files', bytes, {
    params: document ? { path, document } : { path },
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 10 * 60_000,
    suppressErrorMessage: true,
  })
}

/*
 * File grants (Kit Standard KitFiles 1.0): a kit's editor reaches files other than its document
 * only through handles the runtime mints. A grant session is one editor page, bound to its kit and
 * document; the runtime keeps each handle's path, and no answer names one.
 */

const grantOptions = { suppressErrorMessage: true }

/** Opens a grant session for a kit's editor page; answers its id. */
export async function openKitFileSession(body: KitsGrantSessionRequest) {
  const answer = await request.post<KitsGrantSession>('/v1/kits/grants/sessions', body, grantOptions)
  return answer.session
}

/** What a grant session holds now, and its grant log (FA16). */
export function kitFileSession(session: string) {
  return request.get<KitsGrantSessionView>(`/v1/kits/grants/sessions/${encodeURIComponent(session)}`, grantOptions)
}

/** Ends a grant session (its frame closed): its handles expire. Answers them. */
export async function endKitFileSession(session: string) {
  const answer = await request.delete<KitsGrantSessionEnd>(`/v1/kits/grants/sessions/${encodeURIComponent(session)}`, grantOptions)
  return answer.revoked
}

/** Grants a handle on a workspace file or folder the person picked or dropped. */
export function grantKitFile(body: KitsGrantRequest) {
  return request.post<KitsFileStat>('/v1/kits/grants', body, grantOptions)
}

/** `files/create`: a handle on a new file under an unused name, beside the document or in a folder handle. */
export function createKitFile(body: KitsCreateFileRequest) {
  return request.post<KitsFileStat>('/v1/kits/grants/create', body, grantOptions)
}

/** `files/stat`. */
export function statKitFile(session: string, handle: string) {
  return request.get<KitsFileStat>(`/v1/kits/grants/${encodeURIComponent(handle)}`, { ...grantOptions, params: { session } })
}

/** `files/list` on a folder handle: its files, each a new handle with right read. */
export async function listKitFolder(session: string, handle: string) {
  const answer = await request.get<KitsFileList>(`/v1/kits/grants/${encodeURIComponent(handle)}/list`, { ...grantOptions, params: { session } })
  return answer.files
}

/**
 * `files/read`: at most `length` bytes from `offset` (the runtime answers at most 8 MiB), the
 * file's version, and its whole size, so the caller reads on. A refusal rejects with the
 * runtime's status and `data.reason`, as the other requests do.
 */
export async function readKitFile(session: string, handle: string, { offset = 0, length }: { offset?: number; length?: number } = {}) {
  const query = new URLSearchParams({ session, offset: String(offset) })
  if (length !== undefined) query.set('length', String(length))
  const response = await fetch(`${resolveApiURL(`/v1/kits/grants/${encodeURIComponent(handle)}/content`)}?${query}`)
  if (!response.ok) {
    const data = await response.json().catch(() => undefined)
    throw Object.assign(new Error((data as { message?: string } | undefined)?.message ?? `Request failed (${response.status})`), { response: { status: response.status, data } })
  }
  return { bytes: await response.arrayBuffer(), version: response.headers.get('ETag') ?? '', size: Number(response.headers.get('Kition-File-Size') ?? 0) }
}

/**
 * `files/write`: stages one chunk at `offset` (the bytes staged so far); `final` commits it
 * atomically, with `expected`, the version it replaces, for a write handle.
 */
export function writeKitFileChunk(session: string, handle: string, bytes: Uint8Array, { offset, final, expected }: { offset: number; final?: boolean; expected?: string }) {
  return request.put<KitsWriteChunkResult>(`/v1/kits/grants/${encodeURIComponent(handle)}/content`, bytes, {
    ...grantOptions,
    params: { session, offset, final: final || undefined, expected },
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 10 * 60_000,
  })
}

/** `files/release`: unknown and expired handles are ignored. */
export async function releaseKitFiles(session: string, handles: string[]) {
  await request.post('/v1/kits/grants/release', { session, handles }, grantOptions)
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
