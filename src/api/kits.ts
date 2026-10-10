/**
 * Kits: native editors the runtime runs for the open workspace. A kit tab
 * opens a workspace file here, polls its document view for changes (agent
 * edits bump `version`), and loads the rendered preview as an image URL.
 */
import request from './request'
import { resolveApiURL } from '@/services/desktop'
import type { KitsDocumentView, KitsExecuteResult, KitsPhotoDetails } from './generated/kits'

export type { KitsDocumentView, KitsExecuteResult, KitsPhotoDetails }

function unwrap<T>(response: T | { data?: T }) {
  return (response as { data?: T })?.data ?? (response as T)
}

function documentPath(kitId: string, documentId: string) {
  return `/v1/kits/${encodeURIComponent(kitId)}/documents/${encodeURIComponent(documentId)}`
}

export function openKitDocument(path: string) {
  return request
    .post<KitsDocumentView | { data?: KitsDocumentView }>('/v1/kits/documents', { path })
    .then(unwrap<KitsDocumentView>)
}

export function getKitDocument(kitId: string, documentId: string) {
  return request
    .get<KitsDocumentView | { data?: KitsDocumentView }>(documentPath(kitId, documentId))
    .then(unwrap<KitsDocumentView>)
}

export function runKitCommand(kitId: string, documentId: string, command: string, params: Record<string, unknown> = {}) {
  return request
    .post<KitsExecuteResult | { data?: KitsExecuteResult }>(`${documentPath(kitId, documentId)}/commands`, { command, params })
    .then(unwrap<KitsExecuteResult>)
}

export function saveKitDocument(kitId: string, documentId: string) {
  return request
    .post<KitsDocumentView | { data?: KitsDocumentView }>(`${documentPath(kitId, documentId)}/save`, {})
    .then(unwrap<KitsDocumentView>)
}

/** The rendered preview; `version` busts the image cache after each change. */
export function kitPreviewURL(kitId: string, documentId: string, version: number, maxSize = 1600) {
  return resolveApiURL(`${documentPath(kitId, documentId)}/preview?maxSize=${maxSize}&v=${version}`)
}

/** The photo kit's `details`, when they have the expected shape. */
export function photoDetails(view: KitsDocumentView): KitsPhotoDetails | null {
  const details = view.details as Partial<KitsPhotoDetails>
  if (typeof details?.width !== 'number' || !Array.isArray(details.layers)) return null
  return details as KitsPhotoDetails
}

/** The machine-readable reason of a kits API failure, such as `not_installed`. */
export function kitErrorReason(error: unknown): string {
  const data = (error as { response?: { data?: { data?: { reason?: unknown } } } })?.response?.data?.data
  return typeof data?.reason === 'string' ? data.reason : ''
}
