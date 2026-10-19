import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { writeKitFile } from '@/api/kits'
import { notify } from '@/lib/notify'
import { useDocumentReadOnly } from '@/services/documentAccess'
import { documentCommentAccess } from '@/services/documentComments'
import { mountKit, type KitConnection } from '../host/mountKit'
import { KITION_CAPABILITY_SETS } from './capabilitySets'
import { kitCollabHandlers } from './kitLeases'
import { compactKitReplica, KITION_KIT_HOST, readKitReplica, writeKitReplica } from './kitionHost'
import { registerBridgeEditor, reportBridgeChange } from './kitBridge'
import { markKitDocumentShown, registerKitConnection } from './kitConnections'
import { registerKitTestFrame } from './kitTestBridge'
import { kitionTheme } from './kitionTheme'
import { pickWorkspaceFile } from './pickWorkspaceFile'

/** An embedded kit UI in Kition: its package under `public/kits/<dir>/`. */
export type EmbeddedKit = { kitId: string; dir: string; entry?: string }

/**
 * Kition's shortcuts the kit forwards (the kit saves itself with Cmd+S). Cmd+K stays the kit's
 * (Word, Slides, and Sheet insert links with it); Cmd+. opens Kition's command palette from
 * inside a kit instead, a key no kit binds (kit-ui's RESERVED_SHORTCUTS).
 */
const HOST_SHORTCUTS = ['Cmd+N', 'Cmd+O', 'Cmd+W', 'Cmd+T', 'Cmd+,', 'Cmd+Q', 'Cmd+P', 'Cmd+.']

/** A workspace-relative path the kit may name: no absolute paths, nothing above the root (UI-H2). */
function workspacePath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
  if (path.startsWith('/') || parts.some((part) => part === '..') || !parts.length) throw new Error(`${path} is outside the workspace`)
  return parts.join('/')
}

/** The document's own path: a kit keeps only its document's replica. */
function documentPath(wanted: string, path: string) {
  const checked = workspacePath(wanted)
  if (checked !== workspacePath(path)) throw new Error(`${wanted} is not this editor's document`)
  return checked
}

/**
 * The replica of a kit closed to be opened again (a role change), unsaved edits included: its
 * whole history as a change export from nothing, which also opens as a snapshot. `open` says how
 * the next kit opens: from the file as usual (`file`), the carried changes then imported only into
 * an earlier state of this same replica, or from the carried replica alone (`replica`), which
 * opens as saved: its edits show, but the kit does not count them as unsaved.
 */
type Carried = { changes: ArrayBuffer; blobs: ArrayBuffer; open: 'file' | 'replica' }

/** A document id as the two sides may spell it: lowercase hex, no hyphens. */
const docIdKey = (docId: string) => docId.replace(/-/g, '').toLowerCase()

/**
 * Whether the kit `opened` holds an earlier state of the carried replica: the same document, and
 * no change the carried one lacks. Only then do the carried changes continue it. A kit that opened
 * another replica (none was saved with the file, or the file won over the saved one and was
 * recorded onto it as new objects) would take them as more objects: slides twice over.
 */
async function continuesCarried(carried: Carried, opened: KitConnection) {
  const [{ openEnvelope, uuidFromBytes }, { LORO_REPLICA_VERSIONS: versions }] = await Promise.all([import('@/lib/kdm'), import('@/lib/sync/replicaVersions')])
  const changes = new Uint8Array(carried.changes)
  const reached = versions.endOf(changes)
  const version = new Uint8Array(await opened.replica.version())
  // Every opened replica holds at least the change that created its document.
  if (!reached || !version.length || !versions.includes(reached, version)) return false
  const docId = await opened.replica.info().catch(() => null)
  return !docId || docIdKey(docId) === docIdKey(uuidFromBytes(openEnvelope(changes).docId))
}

/** A file name not taken yet: `name.ext`, then `name 2.ext`, … (exports and new files, H5). */
async function unusedPath(path: string) {
  if ((await KITION_KIT_HOST.stamp(path)) == null) return path
  const dot = path.lastIndexOf('.')
  const [stem, extension] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${stem} ${number}${extension}`
    if ((await KITION_KIT_HOST.stamp(candidate)) == null) return candidate
  }
  throw new Error(`no free name for ${path}`)
}

/**
 * A kit that draws its own editor (Kition Kit Standard 6.1): its UI in an iframe, driven over the
 * Kit UI protocol. Kition serves its files, theme, language, and shortcuts, and forwards the Kit
 * AI bridge to it.
 */
/** Who comments in the kit and how (Kit UI protocol `document.comments`), as the kit opens. */
function kitCommentAccess(path: string, readOnly: boolean) {
  const { me, name, canComment, othersReadOnly } = documentCommentAccess(path, readOnly)
  return { me, ...(name ? { name } : {}), canComment, othersReadOnly }
}

/**
 * A replica a kit shows instead of its document's file (the document at a point of its version history): the kit
 * opens it read-only, saves nothing, and is no editor of the file (no agent, co-editing, or bridge registration).
 */
export type KitPreview = { snapshot: ArrayBuffer; blobs: ArrayBuffer }

export function KitFrame({ kit, path, active, onOpenAgent, preview }: { kit: EmbeddedKit; path: string; active: boolean; onOpenAgent?: () => void; preview?: KitPreview }) {
  const { t, i18n } = useTranslation('workspace')
  const frame = useRef<HTMLIFrameElement>(null)
  const [connection, setConnection] = useState<KitConnection | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const latest = useRef({ onOpenAgent, t })
  latest.current = { onOpenAgent, t }
  // A co-edited document this person may only view opens read-only; the kit is opened again
  // when that becomes known after it opened (the role arrives with the room, or changes).
  const documentReadOnly = useDocumentReadOnly(path)
  const readOnly = documentReadOnly || Boolean(preview)
  // The read-only state the kit is open with: it follows `readOnly` once the open kit's replica
  // has been taken (`carried`), so that no edit made before the change is lost when the kit is
  // opened again. The kit opened next takes it (see `Carried`) before anything relays it.
  const [openedReadOnly, setOpenedReadOnly] = useState(readOnly)
  const carried = useRef<Carried | null>(null)
  // Counts the kits opened again from the carried replica, each in a new page (see `Carried`).
  const [reopened, setReopened] = useState(0)
  const src = `/kits/${kit.dir}/${kit.entry ?? 'index.html'}`

  useEffect(() => {
    const element = frame.current
    if (!element) return undefined
    let mounted: KitConnection | null = null
    let closed = false
    let state = { dirty: false, revision: 0 }
    // Who made the last edit: a save after an agent's edits is the agent's checkpoint in the history.
    let lastBy: 'agent' | 'person' = 'person'
    let withdraw: (() => void) | null = null
    // Leases and conflict notices for co-editing (Kit UI protocol sections 7b and 7c).
    const collab = preview ? null : kitCollabHandlers(path, openedReadOnly, () => latest.current.t)
    // A run of this effect that is cleaned up (StrictMode's first run, a closed tab) must not take
    // the kit's one handshake from the run that replaces it.
    const abandon = new AbortController()
    const start = async () => {
      try {
        const { bytes, stamp } = await KITION_KIT_HOST.read(path)
        if (closed) return
        // Opened again from the carried replica, the kit gets no file bytes, so that the replica
        // alone is the document (as when a shared document's file is made), and reads the
        // replica as the one saved with the file as it is now.
        // A preview opens its replica alone, like a kit opened again from a carried replica.
        const carry: Carried | null = preview ? { changes: preview.snapshot, blobs: preview.blobs, open: 'replica' } : carried.current
        const fileStamp = carry?.open === 'replica' ? (stamp ?? (await KITION_KIT_HOST.stamp(path))) : null
        if (closed) return
        let fromCarried = carry && fileStamp ? { snapshot: carry.changes, blobs: carry.blobs, fileStamp } : null
        const lend = KITION_KIT_HOST.lend?.(path) ?? undefined
        mounted = await mountKit(element, {
          signal: abandon.signal,
          origin: window.location.origin,
          host: { name: 'Kition', version: __APP_VERSION__ },
          document: { path, name: path.split('/').pop() ?? path, bytes: fromCarried ? new ArrayBuffer(0) : bytes, version: stamp, lend: lend ?? undefined, ...(openedReadOnly ? { readOnly: true } : {}), comments: kitCommentAccess(path, openedReadOnly) },
          theme: kitionTheme(),
          locale: i18n.language,
          shortcuts: HOST_SHORTCUTS,
          capabilitySets: KITION_CAPABILITY_SETS,
          handlers: {
            read: async ({ path: wanted, offset, length }) => {
              const read = await KITION_KIT_HOST.read(workspacePath(wanted))
              const bytes = offset != null || length != null ? read.bytes.slice(offset ?? 0, length != null ? (offset ?? 0) + length : undefined) : read.bytes
              return { bytes, version: read.stamp ?? '', size: read.bytes.byteLength }
            },
            stamp: async ({ path: wanted }) => ({ version: await KITION_KIT_HOST.stamp(workspacePath(wanted)) }),
            write: async ({ path: wanted, bytes, mode }) => {
              if (openedReadOnly && mode === 'save') throw new Error(`${path} is open read-only`)
              const target = mode === 'save' ? workspacePath(wanted) : await unusedPath(workspacePath(wanted))
              await writeKitFile(target, new Uint8Array(bytes))
              return { path: target, version: (await KITION_KIT_HOST.stamp(target)) ?? '' }
            },
            pick: async ({ accept }) => ({ path: await pickWorkspaceFile(path, accept) }),
            // The replica the kit keeps next to its file (a PSD's), in the document store.
            replicaRead: async ({ path: wanted }) => {
              const checked = documentPath(wanted, path)
              const replica = fromCarried
              fromCarried = null
              return replica ?? readKitReplica(checked, kit.kitId)
            },
            replicaWrite: ({ path: wanted, ...replica }) =>
              preview ? undefined : writeKitReplica(documentPath(wanted, path), kit.kitId, replica, { checkpoint: { origin: lastBy === 'agent' ? 'agent' : 'save', author: lastBy === 'agent' ? 'agent:kition' : 'user:local' } }),
            openAgent: !preview && latest.current.onOpenAgent ? () => latest.current.onOpenAgent?.() : undefined,
            changed: (next) => {
              const agentEdit = next.by === 'agent'
              state = { dirty: next.dirty, revision: next.revision }
              lastBy = agentEdit ? 'agent' : 'person'
              if (!preview) reportBridgeChange({ path, revision: next.revision, by: agentEdit ? 'agent' : 'person' })
            },
            notify: (notice) => {
              const show = notice.level === 'error' ? notify.error : notice.level === 'success' ? notify.success : notice.level === 'warning' ? notify.warning : notify.info
              show(notice.title, notice.description ? { description: notice.description } : undefined)
            },
            ...collab?.handlers,
            // Kition's own shortcuts, pressed inside the kit, reach Kition as if pressed here.
            shortcut: (key) => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: key.key, code: key.code, metaKey: key.meta, ctrlKey: key.ctrl, shiftKey: key.shift, altKey: key.alt, bubbles: true }))
            },
          },
        })
        if (closed) {
          mounted.close()
          return
        }
        // The edits of the kit this one replaces (opened again on a role change), unsaved ones too,
        // imported only into an earlier state of the same replica. A kit that opened another one
        // is opened again, in a new page, from the carried replica.
        if (carry?.open === 'file' && mounted.capabilities.includes('replica')) {
          const continues = await continuesCarried(carry, mounted).catch(() => false)
          if (closed) {
            mounted.close()
            return
          }
          if (!continues) {
            mounted.close()
            mounted = null
            carried.current = { ...carry, open: 'replica' }
            setReopened((count) => count + 1)
            return
          }
          await mounted.replica.importChanges(carry.changes, carry.blobs)
          if (closed) {
            mounted.close()
            return
          }
        }
        if (carry?.open === 'replica' && !fileStamp) console.warn('[kit] could not open the kit again with its edits: the file has no stamp')
        carried.current = null
        if (preview) {
          setConnection(mounted)
          return
        }
        const withdrawEditor = registerBridgeEditor({
          path,
          kitId: kit.kitId,
          revision: () => state.revision,
          dirty: () => state.dirty,
          inspect: async () => (await mounted!.ai.inspect()) as never,
          commands: async (query) => (await mounted!.ai.commands(query)) as never,
          run: async (steps, save) => (await mounted!.ai.run(steps, save)) as never,
          preview: async (maxSize) => (await mounted!.ai.preview(maxSize)).png,
        })
        const withdrawTest = registerKitTestFrame(path, mounted)
        const withdrawConnection = registerKitConnection({ path, kitId: kit.kitId, connection: mounted, readOnly: openedReadOnly })
        const detachCollab = collab?.attach(mounted) ?? (() => undefined)
        withdraw = () => {
          detachCollab()
          withdrawEditor()
          withdrawTest()
          withdrawConnection()
        }
        setConnection(mounted)
      } catch (error) {
        if (!closed) setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    // The kit announces itself when it loads (Kit UI protocol section 1), so this need not
    // wait for the frame's load event, which may already have fired.
    void start()
    return () => {
      closed = true
      abandon.abort()
      withdraw?.()
      mounted?.close()
      setConnection(null)
      // A clean close folds the changes saved since the stored snapshot into a new one.
      if (!preview) void compactKitReplica(path)
    }
  }, [i18n, kit.kitId, path, openedReadOnly, reopened, preview])

  useEffect(() => {
    if (readOnly === openedReadOnly) return undefined
    let cancelled = false
    void (async () => {
      if (connection?.capabilities.includes('replica')) {
        const exported = await connection.replica.exportChanges(new ArrayBuffer(0)).catch((error: unknown) => {
          console.warn('[kit] could not keep the replica before opening the kit again', error)
          return null
        })
        carried.current = exported ? { ...exported, open: 'file' } : null
      }
      if (!cancelled) setOpenedReadOnly(readOnly)
    })()
    return () => {
      cancelled = true
    }
  }, [connection, openedReadOnly, readOnly])

  useEffect(() => {
    connection?.setLocale(i18n.language)
  }, [connection, i18n.language])

  useEffect(() => {
    if (!active || !connection || preview) return
    connection.focus()
    markKitDocumentShown(path)
  }, [active, connection, path, preview])

  return (
    <div className="kit-frame relative h-full min-h-0" data-active={active ? 'true' : undefined} data-testid={preview ? 'kit-frame-preview' : 'kit-frame'}>
      {/* A kit page answers one handshake, so the kit opened again (read-only or not) gets a new page. */}
      <iframe key={`${openedReadOnly ? 'view' : 'edit'}-${reopened}`} ref={frame} src={src} title={path} className="size-full border-0" allow="fullscreen; clipboard-read; clipboard-write" data-testid="kit-frame-window" />
      {failure ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-8" role="alert">
          <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
            <p className="text-[15px] font-semibold text-foreground">{t('kitEditor.openFailed')}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">{failure}</p>
          </div>
        </div>
      ) : connection ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground" data-testid="kit-opening">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('kitEditor.opening')}
        </div>
      )}
    </div>
  )
}
