/**
 * How a kit editor reaches the file it edits. Kition reads workspace files
 * over its loopback API and writes them through `PUT /v1/kits/files`; another
 * host supplies its own. Version stamps (an `etag`, or time and size) let the
 * editor notice when something else, such as an agent, replaced the file.
 */
export type KitHost = {
  /** The file's bytes and the stamp of that version. */
  read: (path: string) => Promise<{ bytes: ArrayBuffer; stamp: string | null }>
  /** The stamp of the file's current version, or null when it cannot tell. */
  stamp: (path: string) => Promise<string | null>
  /** Replaces the file with `bytes`. */
  write: (path: string, bytes: Uint8Array) => Promise<void>
}

/** A version stamp from HTTP headers: the validator, or the time and size. */
export function stampFromHeaders(headers: Headers) {
  return headers.get('etag') || [headers.get('last-modified'), headers.get('content-length')].filter(Boolean).join('|') || null
}
