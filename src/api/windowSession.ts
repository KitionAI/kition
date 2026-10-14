/**
 * This window's session id: one UUID generated once per page load and reused
 * for every data-document request after that. The runtime records
 * `person:session:<uuid>` as the origin of the change, so a window can tell
 * its own edits apart from another window's or the agent's when a live
 * `table/changed` event comes back on the kit bridge stream.
 */
let cachedSessionId: string | null = null

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID (older WebViews).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

/** This window's session id, generated once and reused for the lifetime of the page. */
export function windowSessionId(): string {
  cachedSessionId ??= randomUUID()
  return cachedSessionId
}

/** The origin string the runtime records for an edit made by this window. */
export function windowSessionOrigin(): string {
  return `person:session:${windowSessionId()}`
}

/** Test-only: forces the next `windowSessionId()` call to mint a new id. */
export function resetWindowSessionIdForTests(): void {
  cachedSessionId = null
}
