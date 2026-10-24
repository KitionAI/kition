import { WORKSPACE_RELOAD_EVENT } from '@/api/invalidation'
import { KITION_KIT_HOST, KitRpcError, createKitFile, revealInKit, type KitLinkRef, type KitOpenParams, type KitOpenResult } from '@/features/kits/public'
import { listWorkspaceDocuments } from '@/services/desktop'
import { flattenWorkspaceDocumentItems } from '../../lib/workspaceTree'
import { creatableKits, kitAvailable } from './kitEditors'

/** A workspace path's segments, `.` and `..` resolved; `null` above the root or through a hidden folder (LR2). */
function workspaceSegments(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (part.startsWith('.')) return null
    else parts.push(part)
  }
  return parts.length ? parts : null
}

const extensionOf = (path: string) => (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase()
const stemOf = (path: string) => (path.split('/').pop() ?? '').replace(/\.[^.]*$/, '').toLowerCase()

/**
 * The workspace file a kit's link names from the document at `from` (KitLinks 1.0 LR4): a path
 * relative to the document's folder (a leading `/` from the workspace root), or, for a bare
 * name, the workspace file with that name, one beside the document and of its extension first.
 * A name no file has answers the path a new file would take, beside the document with its
 * extension. `null` for a link Kition cannot place in the workspace (an id alone, a path above
 * the root or in a hidden folder).
 */
export function resolveKitLink(link: KitLinkRef, from: string, files: readonly string[]): { path: string; exists: boolean } | null {
  const folder = from.split('/').filter(Boolean).slice(0, -1).join('/')
  if (link.path) {
    const parts = workspaceSegments(link.path.startsWith('/') ? link.path : `${folder}/${link.path}`)
    if (!parts) return null
    const path = parts.join('/')
    return { path, exists: files.includes(path) }
  }
  const name = link.name?.trim()
  if (!name || name.includes('/') || name.startsWith('.')) return null
  const extension = extensionOf(from)
  const named = files.filter((path) => stemOf(path) === name.toLowerCase() && workspaceSegments(path) !== null)
  const rank = (path: string) => (extensionOf(path) === extension ? 0 : 2) + (path.split('/').slice(0, -1).join('/') === folder ? 0 : 1)
  const found = [...named].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]
  if (found) return { path: found, exists: true }
  return { path: [folder, extension ? `${name}.${extension}` : name].filter(Boolean).join('/'), exists: false }
}

/** What opening a kit's link needs of Kition. */
export type KitLinkOpener = {
  /** Every file of the workspace, by path. */
  files: () => Promise<string[]>
  /** Makes a new, empty file at `path` with a kit that creates its extension (`kit` picks one); `false` when none does. */
  create: (path: string, kit?: string) => Promise<boolean>
  /** Opens `path` in a tab, showing `view` in its editor when there is one. */
  open: (path: string, view?: KitOpenParams['view']) => void
}

const refused = (reason: 'not-found' | 'no-kit', message: string) => new KitRpcError(-32000, message, { reason })

/**
 * `host/open` from the kit editing `from` (KitLinks 1.0 OP2 to OP5): the linked workspace file
 * opens in a tab with its view (OP3); a missing one is `not-found`, unless `create` asks for a new
 * file, which a kit that creates its extension makes first (OP4, never replacing a file), else
 * `no-kit`. Kition opens files in tabs only, so `placement` `beside` opens a tab too.
 */
export async function openKitLink(from: string, params: KitOpenParams, opener: KitLinkOpener): Promise<KitOpenResult> {
  const target = resolveKitLink(params.link, from, await opener.files())
  if (!target) throw refused('not-found', 'the link names no file of the workspace')
  if (!target.exists) {
    if (!params.create) throw refused('not-found', `${target.path} is not in the workspace`)
    if (!(await opener.create(target.path, params.create.kit))) throw refused('no-kit', `no kit makes .${extensionOf(target.path)} files`)
  }
  opener.open(target.path, params.view)
  return { opened: true }
}

/**
 * Kition's side of opening: the workspace's files from its tree, a new file made by the engine of
 * a kit that creates its extension (as the create menu makes one), and a tab opened as the search
 * palette opens one, its kit editor shown at `view`.
 */
export const KITION_LINK_OPENER: KitLinkOpener = {
  files: async () => flattenWorkspaceDocumentItems((await listWorkspaceDocuments()).items ?? []).map((item) => item.path),
  create: async (path, kit) => {
    const extension = extensionOf(path)
    const entry = creatableKits().find((candidate) => candidate.create.extension === extension && (!kit || candidate.embedded.kitId === kit))
    if (!entry || !(await kitAvailable(entry))) return false
    await createKitFile(KITION_KIT_HOST, entry.engine, path, entry.create.size)
    window.dispatchEvent(new Event(WORKSPACE_RELOAD_EVENT))
    return true
  },
  open: (path, view) => {
    if (view) revealInKit(path, view)
    window.dispatchEvent(new CustomEvent('kition:search:open-path', { detail: { path } }))
  },
}
