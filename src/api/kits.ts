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
} from './generated/kits'

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
