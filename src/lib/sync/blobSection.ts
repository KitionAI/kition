// Copied from kition-sdk packages/sync/src/blobSection.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The blobs a kit's replica exports alongside its changes (Kit UI protocol `replica/export`), and
 * how a receiving side finds the blobs a pushed change needs.
 *
 * A blob section is `(64-hex SHA-256 as ASCII, u64 little-endian length, bytes)*`.
 *
 * The sync server relays KDM change bytes only, never a blob list, so the side that imports a
 * change finds its blobs in the change itself: a replica references a blob by its hash, which a
 * KDM change export (Loro updates) carries as plain text. Every 64-hex run in the bytes is a
 * candidate; the server answers which of them it holds (`blob/has`), and those are fetched. A
 * candidate the server does not hold is not a blob (or a blob no one uploaded), and is skipped.
 */

export type BlobEntry = { hash: string; data: Uint8Array }

const HASH_LENGTH = 64
const HEADER_LENGTH = HASH_LENGTH + 8

export function decodeBlobSection(bytes: Uint8Array): BlobEntry[] {
  const entries: BlobEntry[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = new TextDecoder()
  let offset = 0
  while (offset < bytes.length) {
    if (offset + HEADER_LENGTH > bytes.length) throw new Error('a blob section ends inside a blob header')
    const hash = ascii.decode(bytes.subarray(offset, offset + HASH_LENGTH))
    const length = Number(view.getBigUint64(offset + HASH_LENGTH, true))
    const start = offset + HEADER_LENGTH
    if (start + length > bytes.length) throw new Error('a blob section ends inside a blob')
    entries.push({ hash, data: bytes.slice(start, start + length) })
    offset = start + length
  }
  return entries
}

export function encodeBlobSection(entries: readonly BlobEntry[]): Uint8Array {
  const out = new Uint8Array(entries.reduce((total, entry) => total + HEADER_LENGTH + entry.data.length, 0))
  const view = new DataView(out.buffer)
  const ascii = new TextEncoder()
  let offset = 0
  for (const entry of entries) {
    out.set(ascii.encode(entry.hash), offset)
    view.setBigUint64(offset + HASH_LENGTH, BigInt(entry.data.length), true)
    out.set(entry.data, offset + HEADER_LENGTH)
    offset += HEADER_LENGTH + entry.data.length
  }
  return out
}

/** Hex runs longer than this are not split into every window (they are not hash text). */
const LONGEST_RUN = 1024

function isHex(byte: number) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)
}

/**
 * Every lowercase 64-hex string in `bytes` that could be a blob hash: each 64-character window of
 * every run of hex characters, since a hash may sit next to other hex text.
 */
export function blobHashCandidates(bytes: Uint8Array): string[] {
  const found = new Set<string>()
  const ascii = new TextDecoder()
  let start = -1
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && isHex(bytes[index])) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0) {
      const length = index - start
      if (length >= HASH_LENGTH && length <= LONGEST_RUN) {
        for (let at = start; at + HASH_LENGTH <= index; at += 1) found.add(ascii.decode(bytes.subarray(at, at + HASH_LENGTH)))
      }
      start = -1
    }
  }
  return [...found]
}
