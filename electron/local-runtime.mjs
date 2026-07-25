import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function localRuntimeBinaryName(platform) {
  return platform === 'win32' ? 'kition-api.exe' : 'kition-api'
}

export async function discoverSiblingRuntimeBinary({
  clientRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (String(env.KITION_API_BINARY || '').trim() || !clientRoot) {
    return ''
  }

  const candidate = path.resolve(
    clientRoot,
    '..',
    'kition-runtime',
    'dist',
    localRuntimeBinaryName(platform),
  )

  try {
    const stat = await fsp.stat(candidate)
    if (!stat.isFile()) return ''
    if (platform !== 'win32') await fsp.access(candidate, 1)
    return candidate
  } catch {
    return ''
  }
}

export function runtimeResolutionHelp(clientRoot) {
  const siblingBinary = path.resolve(
    clientRoot,
    '..',
    'kition-runtime',
    'dist',
    localRuntimeBinaryName(process.platform),
  )
  return [
    'Renderer-only development: pnpm dev:web',
    `Local full desktop: build ${siblingBinary} or set KITION_API_BINARY=/absolute/path/to/kition-api`,
    'Open-source full desktop: the version pinned by electron/runtime.lock.json must have published runtime assets.',
  ]
}
