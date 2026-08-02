const BUNDLED_ASSET_PREFIX = 'kition-bundled:'
const BUNDLED_ASSET_ORIGIN = 'kition-bundled://assets/'

function isElectronRenderer() {
  if (typeof window === 'undefined') return false
  const bridge = (window as typeof window & { kitionDesktop?: { shell?: string } }).kitionDesktop
  return bridge?.shell === 'electron'
}

export function resolveBundledAssetURL(value: string) {
  const raw = String(value || '').trim()
  const assetPath = raw.toLowerCase().startsWith(BUNDLED_ASSET_PREFIX)
    ? raw.slice(BUNDLED_ASSET_PREFIX.length)
    : raw
  const normalizedPath = assetPath.replace(/^\/+/, '')
  if (!normalizedPath) return ''
  return isElectronRenderer()
    ? `${BUNDLED_ASSET_ORIGIN}${normalizedPath}`
    : `/${normalizedPath}`
}
