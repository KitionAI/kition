import { parseManifest, type ExtensionManifest } from '@/lib/extensions'
import { readZip } from './zip'

/** An extension read from the workspace, checked, ready to install. */
export type ReadExtension = { manifest: ExtensionManifest; source: string; from: string }

/** Reads a workspace file's bytes. */
export type ReadWorkspaceFile = (path: string) => Promise<ArrayBuffer>

const MANIFEST = 'extension.json'
const MAX_MANIFEST = 64 * 1024
const MAX_ENTRY = 8 * 1024 * 1024

const decoder = new TextDecoder('utf-8', { fatal: true })

function text(bytes: Uint8Array, name: string, max: number) {
  if (bytes.byteLength > max) throw new Error(`${name} is larger than ${Math.round(max / 1024)} KB`)
  return decoder.decode(bytes)
}

/** A workspace path without leading, trailing, or doubled slashes; nothing above the workspace. */
export function cleanWorkspacePath(path: string) {
  const parts = path.trim().replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) throw new Error(`${path} is not a path in the workspace`)
  return parts.join('/')
}

/**
 * Reads an extension from the workspace: a folder holding `extension.json` (or that file's path),
 * or a `.zip` of such a folder (`extension.json` at its root or in its one top folder).
 */
export async function readExtensionFromWorkspace(path: string, read: ReadWorkspaceFile): Promise<ReadExtension> {
  const from = cleanWorkspacePath(path)
  if (from.toLowerCase().endsWith('.zip')) return readExtensionZip(new Uint8Array(await read(from)), from)
  const folder = from === MANIFEST ? '' : from.endsWith(`/${MANIFEST}`) ? from.slice(0, -MANIFEST.length - 1) : from
  const inFolder = (name: string) => (folder ? `${folder}/${name}` : name)
  const manifest = parseManifest(text(new Uint8Array(await read(inFolder(MANIFEST))), MANIFEST, MAX_MANIFEST))
  const source = text(new Uint8Array(await read(inFolder(manifest.entry))), manifest.entry, MAX_ENTRY)
  return { manifest, source, from }
}

async function readExtensionZip(archive: Uint8Array, from: string): Promise<ReadExtension> {
  const entries = readZip(archive)
  const names = [...entries.keys()]
  const manifestName = names.includes(MANIFEST) ? MANIFEST : names.find((name) => name.split('/').length === 2 && name.endsWith(`/${MANIFEST}`))
  if (!manifestName) throw new Error(`${from} has no ${MANIFEST} at its root or in its top folder`)
  const prefix = manifestName.slice(0, -MANIFEST.length)
  const manifest = parseManifest(text(await entries.get(manifestName)!.read(), MANIFEST, MAX_MANIFEST))
  const entry = entries.get(prefix + manifest.entry)
  if (!entry) throw new Error(`${from} has no ${manifest.entry}`)
  return { manifest, source: text(await entry.read(), manifest.entry, MAX_ENTRY), from }
}
