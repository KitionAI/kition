/**
 * Attachments held in the table document as blobs: an attachment value whose `url` is
 * `kition-blob:<sha256>` names a blob of the document's own file (the lowercase hex SHA-256 of
 * its bytes), which the data source reads (`attachments.read`) and the app may serve
 * (`TableHost.resolveBlobURL`).
 */
const BLOB_URL_SCHEME = 'kition-blob:'

const BLOB_URL = /^kition-blob:([0-9a-f]{64})$/

/** The blob hash `url` names, or `null` when it names none. */
export function blobHashOfURL(url: unknown): string | null {
  if (typeof url !== 'string') return null
  return BLOB_URL.exec(url.trim())?.[1] ?? null
}

/** The attachment URL that names the blob `hash`. */
export function blobURL(hash: string) {
  return `${BLOB_URL_SCHEME}${hash}`
}
