const BUNDLED_ASSET_PREFIX = 'kition-bundled:'

function bundledAssetPath(value: string) {
  const raw = String(value || '').trim()
  const assetPath = raw.toLowerCase().startsWith(BUNDLED_ASSET_PREFIX)
    ? raw.slice(BUNDLED_ASSET_PREFIX.length)
    : raw
  return assetPath
    .replace(/^\/\/(?:assets)?\/?/i, '')
    .replace(/^\/+/, '')
}

/** Bundled assets are served from the renderer's own origin. */
export function resolveBundledAssetURL(value: string) {
  const normalizedPath = bundledAssetPath(value)
  return normalizedPath ? `/${normalizedPath}` : ''
}

export async function readBundledAssetBytes(
  value: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const assetPath = bundledAssetPath(value)
  if (!assetPath) throw new Error('bundled asset path is empty')
  options.signal?.throwIfAborted()

  const response = await globalThis.fetch(resolveBundledAssetURL(assetPath), {
    signal: options.signal,
  })
  if (!response.ok) {
    throw new Error(`fetch ${resolveBundledAssetURL(assetPath)} failed (${response.status})`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export async function readBundledAssetText(value: string): Promise<string> {
  return new TextDecoder().decode(await readBundledAssetBytes(value))
}

export function bundledAssetArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
