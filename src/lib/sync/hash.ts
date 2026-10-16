// Copied from kition-sdk packages/sync/src/hash.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** The hash blobs are addressed by: lowercase hex SHA-256, over Web Crypto (browser and Node 20+). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
