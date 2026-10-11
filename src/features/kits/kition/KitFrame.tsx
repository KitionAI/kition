import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { writeKitFile } from '@/api/kits'
import { notify } from '@/lib/notify'
import { mountKit, type KitConnection, type KitTheme } from '../host/mountKit'
import { KITION_KIT_HOST } from './kitionHost'
import { registerBridgeEditor, reportBridgeChange } from './kitBridge'

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
  const src = `/kits/${kit.dir}/${kit.entry ?? 'index.html'}`

  useEffect(() => {
    const element = frame.current
    if (!element) return undefined
    let mounted: KitConnection | null = null
    let closed = false
    let state = { dirty: false, revision: 0 }
    let withdraw: (() => void) | null = null
    const start = async () => {
      try {
        const { bytes, stamp } = await KITION_KIT_HOST.read(path)
        const lend = KITION_KIT_HOST.lend?.(path) ?? undefined
        mounted = await mountKit(element, {
          origin: window.location.origin,
          host: { name: 'Kition', version: __APP_VERSION__ },
          document: { path, name: path.split('/').pop() ?? path, bytes, version: stamp, lend: lend ?? undefined },
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
              const target = mode === 'save' ? workspacePath(wanted) : await unusedPath(workspacePath(wanted))
              await writeKitFile(target, new Uint8Array(bytes))
              return { path: target, version: (await KITION_KIT_HOST.stamp(target)) ?? '' }
            },
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
        withdraw = registerBridgeEditor({
          path,
          kitId: kit.kitId,
          revision: () => state.revision,
          dirty: () => state.dirty,
          inspect: async () => (await mounted!.ai.inspect()) as never,
          commands: async (query) => (await mounted!.ai.commands(query)) as never,
          run: async (steps, save) => (await mounted!.ai.run(steps, save)) as never,
          preview: async (maxSize) => (await mounted!.ai.preview(maxSize)).png,
        })
        setConnection(mounted)
      } catch (error) {
        if (!closed) setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    const onLoad = () => void start()
    element.addEventListener('load', onLoad, { once: true })
    return () => {
      closed = true
      element.removeEventListener('load', onLoad)
      withdraw?.()
      mounted?.close()
      setConnection(null)
    }
  }, [i18n, kit.kitId, path])

  useEffect(() => {
    connection?.setLocale(i18n.language)
  }, [connection, i18n.language])

  useEffect(() => {
    if (active) connection?.focus()
  }, [active, connection])

  return (
    <div className="relative h-full min-h-0" data-testid="kit-frame">
      <iframe ref={frame} src={src} title={path} className="size-full border-0" allow="fullscreen; clipboard-read; clipboard-write" data-testid="kit-frame-window" />
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
