const BUNDLED_ASSET_PREFIX = 'kition-bundled:'
const BUNDLED_ASSET_ORIGIN = 'kition-bundled://assets/'

type BundledAssetBridge = {
  shell?: string
  ReadBundledAsset?: (request: { path: string }) => Promise<{
    base64_content: string
    size_bytes: number
  }>
}

function getBundledAssetBridge(): BundledAssetBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as typeof window & { kitionDesktop?: BundledAssetBridge }).kitionDesktop
}

function bundledAssetPath(value: string) {
  const raw = String(value || '').trim()
  const assetPath = raw.toLowerCase().startsWith(BUNDLED_ASSET_PREFIX)
    ? raw.slice(BUNDLED_ASSET_PREFIX.length)
    : raw
  return assetPath
    .replace(/^\/\/(?:assets)?\/?/i, '')
    .replace(/^\/+/, '')
}

export function resolveBundledAssetURL(value: string) {
  const normalizedPath = bundledAssetPath(value)
  if (!normalizedPath) return ''
  return getBundledAssetBridge()?.shell === 'electron'
    ? `${BUNDLED_ASSET_ORIGIN}${normalizedPath}`
    : `/${normalizedPath}`
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function readBundledAssetBytes(
  value: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const assetPath = bundledAssetPath(value)
  if (!assetPath) throw new Error('bundled asset path is empty')
  options.signal?.throwIfAborted()

  const bridge = getBundledAssetBridge()
  if (bridge?.shell === 'electron' && bridge.ReadBundledAsset) {
    const result = await bridge.ReadBundledAsset({ path: assetPath })
    options.signal?.throwIfAborted()
    const bytes = base64ToBytes(result.base64_content)
    if (bytes.byteLength !== result.size_bytes) {
      throw new Error(`bundled asset size mismatch: ${assetPath}`)
    }
    return bytes
  }

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
