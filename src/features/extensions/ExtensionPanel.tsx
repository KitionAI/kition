import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { kitionTheme } from '@/features/kits/public'
import type { ExtensionService } from './extensionService'
import { closeExtensionPanel, type OpenPanel } from './panelState'
import { loadExtensionService } from './serviceLoader'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const hearNothing = () => () => undefined

/**
 * A contributed panel beside a kit document's editor (docs/product-ui-style.md: a white side
 * panel with a hairline border): its title and extension, a close button, and the extension's
 * page in a sandboxed frame that talks to the extension's worker. When the kit's editor opens
 * again (a role change reopens it read-only or editable), the worker's session on the old editor
 * has ended: the panel opens again on the new one by itself.
 */
export default function ExtensionPanel({ path, open }: { path: string; open: OpenPanel }) {
  const { t } = useTranslation('common')
  const host = useRef<HTMLDivElement>(null)
  const [service, setService] = useState<ExtensionService | null>(null)
  const [state, setState] = useState<{ status: 'opening' | 'open' | 'failed'; error?: string }>({ status: 'opening' })

  useEffect(() => {
    let live = true
    void loadExtensionService().then((loaded) => {
      if (live) setService(loaded)
    })
    return () => {
      live = false
    }
  }, [])

  // Which editor of the document extensions work on now: `null` while it (re)opens.
  const opening = useSyncExternalStore(service?.subscribeDocuments ?? hearNothing, () => service?.documentOpening(path) ?? null)

  // The panel closes when its extension is disabled or removed.
  useEffect(() => {
    if (!service) return undefined
    const check = () => {
      if (service.getSnapshot().ready && !service.enabled(open.extension)) closeExtensionPanel(path)
    }
    check()
    return service.subscribe(check)
  }, [service, open.extension, path])

  useEffect(() => {
    const container = host.current
    if (!service || !container) return undefined
    setState({ status: 'opening' })
    // Waits for the document's editor; opens on each editor it gets (`opening` changes).
    if (opening === null) return undefined
    let live = true
    let dispose: (() => void) | null = null
    service
      .showPanel(path, open, container, { theme: kitionTheme().tokens, onNavigated: () => closeExtensionPanel(path) })
      .then((frame) => {
        if (!live) {
          frame.dispose()
          return
        }
        dispose = frame.dispose
        setState({ status: 'open' })
      })
      .catch((error: unknown) => {
        if (live) setState({ status: 'failed', error: message(error) })
      })
    return () => {
      live = false
      dispose?.()
    }
  }, [service, path, open, opening])

  const contributed = service?.host.panelsFor(path).find((panel) => panel.extension === open.extension && panel.id === open.panel)
  const title = contributed?.title ?? open.panel
  return (
    <aside
      className="flex h-full w-[320px] min-w-[240px] max-w-[45%] shrink-0 flex-col border-l border-border bg-background"
      aria-label={title}
      data-testid="extension-panel"
      data-status={state.status}
      data-editor-opening={opening ?? ''}
      data-extension={open.extension}
      data-panel={open.panel}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold leading-5 text-foreground" data-testid="extension-panel-title">
            {title}
          </p>
          {contributed ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{contributed.extensionName}</p> : null}
        </div>
        <Button variant="ghost" size="icon" aria-label={t('extensions.panel.close')} onClick={() => closeExtensionPanel(path)} data-testid="extension-panel-close">
          <X className="size-4" />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {state.status === 'opening' ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('extensions.panel.opening')}
          </div>
        ) : null}
        {state.status === 'failed' ? (
          <div className="absolute inset-0 bg-background p-4" role="alert" data-testid="extension-panel-error">
            <p className="text-[13px] font-medium text-foreground">{t('extensions.panel.failed')}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{state.error}</p>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
