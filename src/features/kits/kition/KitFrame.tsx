import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { writeKitFile } from '@/api/kits'
import { notify } from '@/lib/notify'
import { useDocumentReadOnly } from '@/services/documentAccess'
import { mountKit, type KitConnection, type KitTheme } from '../host/mountKit'
import { KITION_KIT_HOST, readKitReplica, writeKitReplica } from './kitionHost'
import { registerBridgeEditor, reportBridgeChange } from './kitBridge'
import { markKitDocumentShown, registerKitConnection } from './kitConnections'
import { registerKitTestFrame } from './kitTestBridge'
import { pickWorkspaceFile } from './pickWorkspaceFile'

/** An embedded kit UI in Kition: its package under `public/kits/<dir>/`. */
export type EmbeddedKit = { kitId: string; dir: string; entry?: string }

/** Kition's shortcuts the kit forwards (the kit saves itself with Cmd+S). */
const HOST_SHORTCUTS = ['Cmd+N', 'Cmd+O', 'Cmd+W', 'Cmd+T', 'Cmd+,', 'Cmd+Q', 'Cmd+P']

/** Kition's design tokens as the Kit UI protocol's theme (docs/design.md). */
function kitionTheme(): KitTheme {
  const sans = getComputedStyle(document.body).fontFamily
  return {
    colorScheme: 'light',
    tokens: {
      '--kit-font-sans': sans,
      '--kit-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      '--kit-surface': '#ffffff',
      '--kit-surface-muted': '#fafaf9',
      '--kit-canvas': '#f6f5f4',
      '--kit-text': '#1a1a1a',
      '--kit-text-muted': '#5d5b54',
      '--kit-border': '#e5e3df',
      '--kit-primary': '#5645d4',
      '--kit-primary-text': '#ffffff',
      '--kit-primary-soft': 'rgba(86, 69, 212, 0.1)',
      '--kit-danger': '#e03131',
      '--kit-radius-control': '8px',
      '--kit-radius-card': '12px',
      '--kit-shadow-card': '0 1px 2px rgba(15, 15, 15, 0.06), 0 4px 16px rgba(15, 15, 15, 0.06)',
    },
  }
}

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
export function KitFrame({ kit, path, active, onOpenAgent }: { kit: EmbeddedKit; path: string; active: boolean; onOpenAgent?: () => void }) {
  const { t, i18n } = useTranslation('workspace')
  const frame = useRef<HTMLIFrameElement>(null)
  const [connection, setConnection] = useState<KitConnection | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const latest = useRef({ onOpenAgent, t })
  latest.current = { onOpenAgent, t }
  // A co-edited document this person may only view opens read-only; the kit is opened again
  // when that becomes known after it opened (the role arrives with the room, or changes).
  const readOnly = useDocumentReadOnly(path)
  // The read-only state the kit is open with: it follows `readOnly` once the open kit's replica
  // has been taken (`carried`), so that no edit made before the change is lost when the kit is
  // opened again from its file. The kit opened next imports it before anything relays it.
  const [openedReadOnly, setOpenedReadOnly] = useState(readOnly)
  const carried = useRef<{ changes: ArrayBuffer; blobs: ArrayBuffer } | null>(null)
  const src = `/kits/${kit.dir}/${kit.entry ?? 'index.html'}`

  useEffect(() => {
    const element = frame.current
    if (!element) return undefined
    let mounted: KitConnection | null = null
    let closed = false
    let state = { dirty: false, revision: 0 }
    let withdraw: (() => void) | null = null
    // A run of this effect that is cleaned up (StrictMode's first run, a closed tab) must not take
    // the kit's one handshake from the run that replaces it.
    const abandon = new AbortController()
    const start = async () => {
      try {
        const { bytes, stamp } = await KITION_KIT_HOST.read(path)
        if (closed) return
        const lend = KITION_KIT_HOST.lend?.(path) ?? undefined
        mounted = await mountKit(element, {
          signal: abandon.signal,
          origin: window.location.origin,
          host: { name: 'Kition', version: __APP_VERSION__ },
          document: { path, name: path.split('/').pop() ?? path, bytes, version: stamp, lend: lend ?? undefined, ...(openedReadOnly ? { readOnly: true } : {}) },
          theme: kitionTheme(),
          locale: i18n.language,
          shortcuts: HOST_SHORTCUTS,
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
            replicaRead: ({ path: wanted }) => readKitReplica(documentPath(wanted, path), kit.kitId),
            replicaWrite: ({ path: wanted, ...replica }) => writeKitReplica(documentPath(wanted, path), kit.kitId, replica),
            openAgent: latest.current.onOpenAgent ? () => latest.current.onOpenAgent?.() : undefined,
            changed: (next) => {
              const agentEdit = next.by === 'agent'
              state = { dirty: next.dirty, revision: next.revision }
              reportBridgeChange({ path, revision: next.revision, by: agentEdit ? 'agent' : 'person' })
            },
            notify: (notice) => {
              const show = notice.level === 'error' ? notify.error : notice.level === 'success' ? notify.success : notice.level === 'warning' ? notify.warning : notify.info
              show(notice.title, notice.description ? { description: notice.description } : undefined)
            },
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
        // The edits of the kit this one replaces (opened again on a role change), unsaved ones too.
        const carry = carried.current
        if (carry && mounted.capabilities.includes('replica')) {
          await mounted.replica.importChanges(carry.changes, carry.blobs)
          if (closed) {
            mounted.close()
            return
          }
        }
        carried.current = null
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
        withdraw = () => {
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
    }
  }, [i18n, kit.kitId, path, openedReadOnly])

  useEffect(() => {
    if (readOnly === openedReadOnly) return undefined
    let cancelled = false
    void (async () => {
      if (connection?.capabilities.includes('replica')) {
        carried.current = await connection.replica.exportChanges(new ArrayBuffer(0)).catch((error: unknown) => {
          console.warn('[kit] could not keep the replica before opening the kit again', error)
          return null
        })
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
    if (!active || !connection) return
    connection.focus()
    markKitDocumentShown(path)
  }, [active, connection, path])

  return (
    <div className="relative h-full min-h-0" data-testid="kit-frame">
      {/* A kit page answers one handshake, so the kit opened again (read-only or not) gets a new page. */}
      <iframe key={openedReadOnly ? 'view' : 'edit'} ref={frame} src={src} title={path} className="size-full border-0" allow="fullscreen; clipboard-read; clipboard-write" data-testid="kit-frame-window" />
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
