import { endKitFileSession, grantKitFile, openKitFileSession, writeKitFileChunk } from '@/api/kits'
import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { FILE_ERROR_REASONS, KitRpcError, type KitFileErrorReason, type KitFilesPickParams } from '../host/protocol'
import { fileError, type KitFileEntry, type KitFilesManifest, type KitFilesOptions, type KitFilesStorage } from '../host/files'
import { openWithUnsavedEdits } from './kitBridge'
import { kitionPrint } from './kitionPrint'
import { readKitFile, stampKitFile } from './kitionHost'

/** The largest chunk one `files/write` request carries to the runtime (it takes 64 MiB). */
const CHUNK_BYTES = 32 << 20

/** How long one listing of the workspace answers `stat` and `list`: the requests of one pick or create. */
const LISTING_MS = 1000

/** A workspace path a kit may reach (H3, LR2, FA8): relative, no `..`, no hidden segment such as `.kition/`. */
export function visiblePath(ref: string) {
  const parts = ref.split('/')
  return Boolean(ref) && !ref.includes('\\') && parts.every((part) => part !== '' && part !== '..' && !part.startsWith('.'))
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** The runtime's refusal as the KitFiles reason the kit sees; `io-error` for anything else (no path in the message). */
function refusal(error: unknown) {
  const reason = (error as { response?: { data?: { data?: { reason?: unknown } } } })?.response?.data?.data?.reason
  const known = typeof reason === 'string' && (FILE_ERROR_REASONS as readonly string[]).includes(reason)
  return fileError(known ? (reason as KitFileErrorReason) : 'io-error', known ? `the host refused the file (${reason})` : 'the host could not reach the file')
}

type Listing = { files: Map<string, WorkspaceDocumentTreeItem>; folders: Set<string> }

function indexTree(items: WorkspaceDocumentTreeItem[], listing: Listing = { files: new Map(), folders: new Set() }) {
  for (const item of items) {
    if (!visiblePath(item.path)) continue
    if (item.type === 'folder') {
      listing.folders.add(item.path)
      indexTree(item.children ?? [], listing)
    } else {
      listing.files.set(item.path, item)
    }
  }
  return listing
}

/**
 * Kition's workspace as a kit's file storage (KitFiles 1.0, `files/*`), for the kit editing
 * `document`: workspace paths are its references, which never reach the kit. Reads go through the
 * kit file service, which serves no hidden path (LR2); writes go through a runtime grant session
 * bound to this kit and document, so a new file never replaces one (H5) and a replacement commits
 * only over the version the kit read (FA9). The session opens with the first write; `end` closes it.
 */
function kitionFilesStorage({ kit, document, manifest, readOnly }: { kit: string; document: string; manifest: KitFilesManifest; readOnly: boolean }) {
  let session: Promise<string> | null = null
  let listing: { at: number; value: Promise<Listing> } | null = null

  const workspace = () => {
    if (!listing || Date.now() - listing.at > LISTING_MS) {
      listing = { at: Date.now(), value: listWorkspaceDocuments().then((answer) => indexTree(answer.items ?? [])) }
    }
    return listing.value
  }
  const grants = () => {
    session ??= openKitFileSession({ kit, document, files: manifest, readOnly })
    return session
  }

  const storage: KitFilesStorage = {
    stat: async (ref) => {
      if (!visiblePath(ref)) return null
      const { files, folders } = await workspace()
      if (folders.has(ref)) return { kind: 'folder', version: null }
      const version = await stampKitFile(ref)
      if (version === null) return null
      const entry: KitFileEntry = { kind: 'file', version }
      const size = files.get(ref)?.size
      return size === undefined ? entry : { ...entry, size }
    },
    read: async (ref, offset, length) => {
      if (!visiblePath(ref)) throw fileError('file-not-granted', 'this file is not available to the kit')
      const { bytes, stamp } = await readKitFile(ref)
      const end = length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, offset + length)
      return { bytes: bytes.slice(Math.min(offset, bytes.byteLength), end), version: stamp ?? '', size: bytes.byteLength }
    },
    list: async (folder) => {
      const { files, folders } = await workspace()
      return [...folders, ...files.keys()].filter((path) => parentOf(path) === folder).sort()
    },
    child: (folder, name) => join(folder ?? parentOf(document), name),
    unsaved: (ref) => openWithUnsavedEdits(ref),
    commit: async (ref, bytes, mode) => {
      if (!visiblePath(ref)) throw fileError('not-allowed', 'this file is not available to the kit')
      let id: string
      let handle: string
      let expected: string | null = null
      try {
        id = await grants()
        const granted = await grantKitFile({ session: id, path: ref, kind: 'file', rights: [mode.mode === 'create' ? 'create' : 'write'], flow: 'pick' })
        handle = granted.handle
        // The kit replaces the version it read from the kit file service (or the one its last
        // write answered); the runtime commits over its own stamp of the same file, taken with the
        // grant. Checked after the grant, so a change in between is a conflict too.
        if (mode.mode === 'replace') {
          expected = granted.version ?? ''
          if (mode.expected !== expected && mode.expected !== (await stampKitFile(ref))) throw fileError('conflict', 'the file changed since the version the kit read')
        }
      } catch (error) {
        throw error instanceof KitRpcError ? error : refusal(error)
      }
      let version = ''
      try {
        // Staged in chunks; the last one (the only one for a small file) commits.
        let offset = 0
        for (;;) {
          const end = Math.min(bytes.byteLength, offset + CHUNK_BYTES)
          const final = end === bytes.byteLength
          const answer = await writeKitFileChunk(id, handle, bytes.subarray(offset, end), {
            offset,
            final,
            ...(final && expected !== null ? { expected } : {}),
          })
          if (final) {
            version = answer.version ?? ''
            break
          }
          offset = end
        }
      } catch (error) {
        throw refusal(error)
      }
      listing = null
      return { version }
    },
  }

  return {
    storage,
    /** Ends the runtime grant session, if one was opened: its handles expire. */
    end: async () => {
      const opened = session
      session = null
      if (opened) await opened.then(endKitFileSession).catch(() => undefined)
    },
  }
}

/** The `files` lists of the kit's manifest (K15), from its package's `kit.json`; none when it declares none. */
async function kitFilesManifest(dir: string): Promise<KitFilesManifest | null> {
  const response = await fetch(`/kits/${dir}/kit.json`, { cache: 'no-store' }).catch(() => null)
  if (!response?.ok) return null
  const manifest = (await response.json().catch(() => null)) as { files?: KitFilesManifest } | null
  return manifest?.files && typeof manifest.files === 'object' ? manifest.files : null
}

/**
 * `mountKit`'s `files` option for the kit in package `dir` editing `document`, when its manifest
 * asks for files (none otherwise): the workspace as its storage, `pick` as its picker, and
 * Kition's printing for a kit that may print. `end` closes the grant session.
 */
export async function kitionFilesOption({ kit, dir, document, readOnly, pick }: { kit: string; dir: string; document: string; readOnly: boolean; pick: (params: KitFilesPickParams) => Promise<string[]> }) {
  const manifest = await kitFilesManifest(dir)
  if (!manifest) return null
  const { storage, end } = kitionFilesStorage({ kit, document, manifest, readOnly })
  const print = manifest.print ? kitionPrint() : undefined
  const option: KitFilesOptions = { storage, kit, principal: 'user:local', manifest, pick, ...(print ? { print } : {}) }
  return { option, end }
}
