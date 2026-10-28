import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as Loader2 } from '@kition/tessera-icons/react'
import { writeKitFile } from '@/api/kits'
import { isTableFilePath, notifyTableFilesChanged } from '@/api/kitTables'
import { Button } from '@kition/tessera-ui'
import { DocumentSchemaBanner } from '@/components/DocumentSchemaBanner'
import { FileNotice } from '@/components/states'
import { notify } from '@/lib/notify'
import { useDocumentReadOnly } from '@/services/documentAccess'
import { documentCommentAccess } from '@/services/documentComments'
import { useDocumentSchemaNotice } from '@/services/documentSchema'
import { mountKit, type KitConnection, type KitHostHandlers, type KitLinksPickParams, type KitOpenParams, type KitOpenResult } from '../host/mountKit'
import { KITION_CAPABILITY_SETS } from './capabilitySets'
import { kitCollabHandlers } from './kitLeases'
import { compactKitReplica, KITION_KIT_HOST, readKitFile, readKitReplica, stampKitFile, writeKitReplica } from './kitionHost'
import { registerBridgeEditor, reportBridgeChange } from './kitBridge'
import { bridgeModel } from './kitBridgeModel'
import { setKitDraft } from './kitDrafts'
import { kitionActions } from './kitActions'
import { kitionGenerate } from './kitGenerate'
import { KitDraftControls } from './KitDraftReview'
import { markKitDocumentShown, registerKitConnection } from './kitConnections'
import { followKitFileChanges } from './kitFileChanges'
import { registerKitTestFrame } from './kitTestBridge'
import { kitionTheme } from './kitionTheme'
import { openingView, useKitReveal } from './kitViews'
import { pickWorkspaceFile } from './pickWorkspaceFile'
import { openConfirmedUrl, useOpenUrlConfirmation } from './KitOpenUrlDialog'
import { kitionFilesOption } from './kitionFiles'
import { useWorkspacePicker, type WorkspacePickRequest } from './WorkspaceFilePicker'

/** An embedded kit UI in Kition: its package under `public/kits/<dir>/`. */
export type EmbeddedKit = { kitId: string; dir: string; entry?: string }

/**
 * Kition's shortcuts the kit forwards (the kit saves itself with Cmd+S). Cmd+K stays the kit's
 * (Word, Slide, and Sheet insert links with it); Cmd+. opens Kition's command palette from
 * inside a kit instead, a key no kit binds (kit-editor's RESERVED_SHORTCUTS).
 */
const HOST_SHORTCUTS = ['Cmd+N', 'Cmd+O', 'Cmd+W', 'Cmd+T', 'Cmd+,', 'Cmd+Q', 'Cmd+P', 'Cmd+.']

/** A workspace-relative path the kit may name: no absolute paths, nothing above the root (UI-H2). */
function workspacePath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
  if (path.startsWith('/') || parts.some((part) => part === '..') || !parts.length) throw new Error(`${path} is outside the workspace`)
  return parts.join('/')
}

/** The document's own path: a kit saves only its document, and keeps only its document's replica. */
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
 * What a kit may read (`host/read`) and ask the stamp of (`host/stamp`): its own document, through
 * Kition's file service wherever the document is; and any other workspace file whose path has no
 * hidden segment, through the kit file service (which the runtime confines the same way): the
 * files beside the document, and those its links name elsewhere (film and effect clips, linked
 * pictures). Never Kition's own store (`.kition/`, other documents' replicas and comment threads)
 * or any other hidden file or folder (rule LR2). The lent files engines read follow the same rule.
 */
function readableFile(wanted: string, path: string) {
  const checked = workspacePath(wanted)
  if (checked === workspacePath(path)) return { path: checked, own: true }
  if (checked.split('/').some((part) => part.startsWith('.'))) throw new Error(`${wanted} is not readable by a kit`)
  return { path: checked, own: false }
}

/** `host/read` from the kit editing `path`, within what it may read (`readableFile`). */
async function readForKit(path: string, { path: wanted, offset, length }: Parameters<KitHostHandlers['read']>[0]) {
  const file = readableFile(wanted, path)
  const read = file.own ? await KITION_KIT_HOST.read(file.path) : await readKitFile(file.path)
  const bytes = offset != null || length != null ? read.bytes.slice(offset ?? 0, length != null ? (offset ?? 0) + length : undefined) : read.bytes
  return { bytes, version: read.stamp ?? '', size: read.bytes.byteLength }
}

/**
 * `host/write` from the kit editing `path`: a save writes only that document; exports and new
 * files are new files under unused names. The runtime holds both rules too: a save names its
 * document, and no other write replaces a file.
 */
async function writeForKit(path: string, readOnly: boolean, { path: wanted, bytes, mode }: Parameters<KitHostHandlers['write']>[0]) {
  if (mode === 'save' && readOnly) throw new Error(`${path} is open read-only`)
  const target = mode === 'save' ? documentPath(wanted, path) : await unusedPath(workspacePath(wanted))
  await writeKitFile(target, new Uint8Array(bytes), mode === 'save' ? { document: target } : {})
  // Kition's own table pickers (workflows) read the saved tables.
  if (isTableFilePath(target)) notifyTableFilesChanged(target)
  return { path: target, version: (await KITION_KIT_HOST.stamp(target)) ?? '' }
}

/** Who comments in the kit and how (Kit UI protocol `document.comments`), as the kit opens. */
function kitCommentAccess(path: string, readOnly: boolean) {
  const { me, name, canComment, othersReadOnly } = documentCommentAccess(path, readOnly)
  return { me, ...(name ? { name } : {}), canComment, othersReadOnly }
}

/**
 * A kit that draws its own editor (Kition Kit Standard 6.1): its UI in an iframe, driven over the
 * Kit UI protocol. Kition serves its files, theme, language, and shortcuts, and forwards the Kit
 * AI bridge to it.
 */
/**
 * A replica a kit shows instead of its document's file (the document at a point of its version history): the kit
 * opens it read-only, saves nothing, and is no editor of the file (no agent, co-editing, or bridge registration).
 */
export type KitPreview = { snapshot: ArrayBuffer; blobs: ArrayBuffer }

/**
 * The version of the kit's package this Kition ships (its `kit-ui.json`), once `wanted`: for the
 * notice of a document a newer kit edited.
 */
function useKitPackageVersion(dir: string, wanted: boolean) {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (!wanted) return undefined
    let cancelled = false
    void fetch(`/kits/${dir}/kit-ui.json`, { cache: 'no-store' })
      .then(async (response) => (response.ok ? ((await response.json()) as { version?: unknown }) : null))
      .then((marker) => {
        if (!cancelled && typeof marker?.version === 'string') setVersion(marker.version)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [dir, wanted])
  return version
}

/** Shown over the frame when the kit could not open the file: which file, that it is unchanged, and the kit's reason. */
function KitOpenFailure({ path, kitName, failure, onRetry }: { path: string; kitName: string; failure: string; onRetry: () => void }) {
  const { t } = useTranslation('workspace')
  return (
    <FileNotice
      title={t('kitEditor.openFailedTitle', { name: fileName(path) })}
      message={t('kitEditor.openFailedMessage', { type: fileTypeName(path, kitName) })}
      detail={failure}
      data-testid="kit-open-failed"
    >
      <Button size="md" variant="secondary" onClick={onRetry} data-testid="kit-open-retry">
        {t('kitEditor.tryAgain')}
      </Button>
    </FileNotice>
  )
}

/** The file's name, the last part of its workspace path. */
function fileName(path: string) {
  return path.split('/').pop() || path
}

/** How the notice names the file's type: its extension in capitals (PSD), or the kit's name. */
function fileTypeName(path: string, kitName: string) {
  const match = /\.([^./]+)$/.exec(fileName(path))
  return match ? match[1].toUpperCase() : kitName
}

/** Covers the frame while the kit opens its document. */
function KitOpening({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground" data-testid="kit-opening">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  )
}

/**
 * Links (KitLinks 1.0 section 5): files open in Kition's tabs (`onOpenLink`, when the editor has
 * it), web addresses in the system's browser after the person confirmed them (OP8). Both work in
 * read-only documents (OP5).
 */
/** `host/stamp`: the version of the document's own file or of a file beside it the kit may read. */
async function stampForKit(document: string, { path: wanted }: { path: string }) {
  const file = readableFile(wanted, document)
  return { version: file.own ? await KITION_KIT_HOST.stamp(file.path) : await stampKitFile(file.path) }
}

/**
 * `links/pick` (Kit UI protocol 2.5, UI-N2): the person chooses existing workspace files in
 * Kition's own picker, which offers only `accept`'s visible files and not the document; nothing
 * is copied. Answers their workspace paths and stamps; `mountKit` names them from the document's
 * folder. `host/read` and `host/stamp` serve them like the other files a kit may read (UI-N3).
 */
async function pickLinkedFiles(pick: (request: WorkspacePickRequest) => Promise<string[]>, document: string, params: KitLinksPickParams) {
  const paths = await pick({ mode: 'link', ...params })
  const readable = paths.filter((wanted) => {
    try {
      return !readableFile(wanted, document).own
    } catch {
      return false
    }
  })
  return Promise.all(readable.map(async (path) => ({ path, version: await stampKitFile(path).catch(() => null) })))
}

/** `host/notify`: the kit's notice as one of Kition's toasts. */
function showKitNotice(notice: { level?: string; title: string; description?: string }) {
  const show = notice.level === 'error' ? notify.error : notice.level === 'success' ? notify.success : notice.level === 'warning' ? notify.warning : notify.info
  show(notice.title, notice.description ? { description: notice.description } : undefined)
}

/** `host/shortcut`: Kition's own shortcuts, pressed inside the kit, reach Kition as if pressed here. */
function relayShortcut(key: { key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: key.key, code: key.code, metaKey: key.meta, ctrlKey: key.ctrl, shiftKey: key.shift, altKey: key.alt, bubbles: true }))
}

function linkHandlers(latest: { current: { onOpenLink?: (params: KitOpenParams) => Promise<KitOpenResult>; askUrl: (url: string) => Promise<boolean> } }): Pick<KitHostHandlers, 'open' | 'openUrl'> {
  const { onOpenLink } = latest.current
  return {
    open: onOpenLink ? (params) => (latest.current.onOpenLink ?? onOpenLink)(params) : undefined,
    openUrl: openConfirmedUrl((url) => latest.current.askUrl(url)),
  }
}

/**
 * `onOpenLink` opens a workspace file a link in the kit names (`host/open`, KitLinks 1.0 OP2 to
 * OP5); without it the kit offers no opening of files. Web addresses (`host/openUrl`) open in the
 * system's browser once the person confirmed them (OP8).
 */
export function KitFrame({ kit, path, active, onOpenAgent, onOpenLink, preview }: { kit: EmbeddedKit; path: string; active: boolean; onOpenAgent?: () => void; onOpenLink?: (params: KitOpenParams) => Promise<KitOpenResult>; preview?: KitPreview }) {
  const { t, i18n } = useTranslation('workspace')
  const frame = useRef<HTMLIFrameElement>(null)
  const [connection, setConnection] = useState<KitConnection | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const openUrl = useOpenUrlConfirmation()
  const picker = useWorkspacePicker(path)
  const latest = useRef({ onOpenAgent, onOpenLink, askUrl: openUrl.ask, t })
  latest.current = { onOpenAgent, onOpenLink, askUrl: openUrl.ask, t }
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
  // A co-edited document a newer kit edited (Kit Standard 2.0 rules M5a and M20): its notice names
  // the kit and the version this Kition ships.
  const schemaNotice = useDocumentSchemaNotice(preview ? undefined : path)
  const kitVersion = useKitPackageVersion(kit.dir, Boolean(schemaNotice))
  const kitName = t(`documentSchema.kits.${kit.kitId.replace(/^kit\./, '')}`, { defaultValue: kit.kitId })

  useEffect(() => {
    const element = frame.current
    if (!element) return undefined
    let mounted: KitConnection | null = null
    let closed = false
    let state = { dirty: false, revision: 0 }
    // Who made the last edit: a save after an agent's edits is the agent's checkpoint in the history.
    let lastBy: 'agent' | 'person' = 'person'
    let withdraw: (() => void) | null = null
    // The workspace as the kit's file storage (KitFiles 1.0), for a kit whose manifest asks for files.
    let files: Awaited<ReturnType<typeof kitionFilesOption>> = null
    // Leases, conflict notices, presence, and newer-kit notices (Kit UI protocol sections 7b, 7c, 7e, and 7f).
    const collab = preview ? null : kitCollabHandlers(path, kit.kitId, openedReadOnly, () => latest.current.t)
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
        files = preview ? null : await kitionFilesOption({ kit: kit.kitId, dir: kit.dir, document: path, readOnly: openedReadOnly, pick: picker.pick })
        if (closed) return
        let fromCarried = carry && fileStamp ? { snapshot: carry.changes, blobs: carry.blobs, fileStamp } : null
        const lend = KITION_KIT_HOST.lend?.(path) ?? undefined
        mounted = await mountKit(element, {
          signal: abandon.signal,
          origin: window.location.origin,
          host: { name: 'Kition', version: __APP_VERSION__ },
          ...(files ? { files: files.option } : {}),
          document: { path, name: path.split('/').pop() ?? path, bytes: fromCarried ? new ArrayBuffer(0) : bytes, version: stamp, lend: lend ?? undefined, ...(preview ? {} : openingView(path)), ...(openedReadOnly ? { readOnly: true } : {}), comments: kitCommentAccess(path, openedReadOnly) },
          theme: kitionTheme(),
          locale: i18n.language,
          shortcuts: HOST_SHORTCUTS,
          capabilitySets: KITION_CAPABILITY_SETS,
          handlers: {
            read: (params) => readForKit(path, params),
            stamp: (params) => stampForKit(path, params),
            write: (params) => writeForKit(path, openedReadOnly, params),
            pick: async ({ accept }) => ({ path: await pickWorkspaceFile(path, accept) }),
            // Files the kit links where they are (`links/pick`): not for a preview or a read-only
            // document, whose kit cannot store the link (UI-N4).
            pickLinks: preview || openedReadOnly ? undefined : (params) => pickLinkedFiles(picker.pick, path, params),
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
            ...(preview ? {} : linkHandlers(latest)),
            changed: (next) => {
              const agentEdit = next.by === 'agent'
              state = { dirty: next.dirty, revision: next.revision }
              lastBy = agentEdit ? 'agent' : 'person'
              if (!preview) reportBridgeChange({ path, revision: next.revision, by: agentEdit ? 'agent' : 'person' })
            },
            notify: showKitNotice,
            draftChanged: (info) => setKitDraft(path, info),
            // The person's models for what the kit generates (Kit UI protocol section 7j): not for a
            // preview or a read-only document, which the kit cannot write an answer into.
            generate: preview || openedReadOnly ? undefined : (params) => kitionGenerate(params),
            // Kition's features a kit offers controls for (section 7j): run a workflow on a record,
            // start a design from one.
            actions: preview || openedReadOnly ? undefined : kitionActions(path),
            ...collab?.handlers,
            shortcut: relayShortcut,
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
          inspect: async (options) => (await mounted!.ai.inspect(options)) as never,
          commands: async (query) => (await mounted!.ai.commands(query)) as never,
          run: async (steps, save, options) => (await mounted!.ai.run(steps, save, options)) as never,
          preview: async (maxSize, options) => (await mounted!.ai.preview(maxSize, options)).png,
          // The agent's drafts (Kit UI protocol section 7d): it may ask for review or take one back.
          draft: mounted.capabilities.includes('draft') ? { ready: () => mounted!.draft.ready(), reopen: () => mounted!.draft.reopen() } : undefined,
          model: bridgeModel(mounted, kit.kitId),
          save: openedReadOnly ? undefined : async () => (await mounted!.save()).saved,
          // Diagnostics (Kit Standard 2.0 A21): only from a kit that lists `check`, so an older one is refused, not "fine".
          check: mounted.capabilities.includes('check') ? (options) => mounted!.check(options) : undefined,
        })
        const withdrawTest = registerKitTestFrame(path, mounted)
        const withdrawConnection = registerKitConnection({ path, kitId: kit.kitId, connection: mounted, readOnly: openedReadOnly })
        const detachCollab = collab?.attach(mounted) ?? (() => undefined)
        const stopFileChanges = followKitFileChanges(path, mounted, KITION_KIT_HOST.stamp)
        withdraw = () => {
          stopFileChanges()
          // A draft lives in its kit's page: it goes when the kit closes.
          setKitDraft(path, { state: 'none', revision: null })
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
      void files?.end()
      setConnection(null)
      // A clean close folds the changes saved since the stored snapshot into a new one.
      if (!preview) void compactKitReplica(path)
    }
  }, [i18n, kit.kitId, kit.dir, path, openedReadOnly, reopened, preview, picker.pick])

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

  useEffect(() => connection?.setLocale(i18n.language), [connection, i18n.language])
  // Kition asked the open editor to show somewhere else (`document/reveal`).
  useKitReveal(path, preview ? null : connection)

  useEffect(() => {
    if (!active || !connection || preview) return
    connection.focus()
    markKitDocumentShown(path)
  }, [active, connection, path, preview])

  return (
    <div className="kit-frame relative flex h-full min-h-0 flex-col" data-active={active ? 'true' : undefined} data-ready={connection ? 'true' : undefined} data-testid={preview ? 'kit-frame-preview' : 'kit-frame'}>
      {preview ? null : <DocumentSchemaBanner path={path} kitName={kitName} kitVersion={kitVersion} />}
      <KitDraftControls connection={connection} kitId={kit.kitId} path={path} active={active} />
      {/* A kit page answers one handshake, so the kit opened again (read-only or not) gets a new page. */}
      <iframe key={`${openedReadOnly ? 'view' : 'edit'}-${reopened}`} ref={frame} src={src} title={path} className="min-h-0 w-full flex-1 border-0" allow="fullscreen; clipboard-read; clipboard-write" data-testid="kit-frame-window" />
      {failure ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-8">
          <KitOpenFailure
            path={path}
            kitName={kitName}
            failure={failure}
            onRetry={() => {
              // Opens the kit again in a new page.
              setFailure(null)
              setReopened((count) => count + 1)
            }}
          />
        </div>
      ) : connection ? null : <KitOpening label={t('kitEditor.opening')} />}
      {openUrl.dialog}
      {picker.dialog}
    </div>
  )
}
