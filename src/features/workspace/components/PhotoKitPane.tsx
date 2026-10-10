import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Layers, Loader2, Redo2, RefreshCw, Save, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'
import {
  getKitDocument,
  kitErrorReason,
  kitPreviewURL,
  openKitDocument,
  photoDetails,
  runKitCommand,
  saveKitDocument,
  type KitsDocumentView,
} from '@/api/kits'

const POLL_INTERVAL_MS = 2000

type PhotoKitPaneProps = {
  path: string
  active: boolean
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: KitsDocumentView }
  | { kind: 'not-installed'; message: string }
  | { kind: 'failed'; message: string }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A layered image (PSD, PSB, .pcraft) opened in the Photo kit. The kit renders
 * the canvas; this tab shows the preview and layers, and refreshes when the
 * agent edits the same file.
 */
export function PhotoKitPane({ path, active }: PhotoKitPaneProps) {
  const { t } = useTranslation('workspace')
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState<'undo' | 'redo' | 'save' | null>(null)
  const viewRef = useRef<KitsDocumentView | null>(null)

  const open = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const view = await openKitDocument(path)
      viewRef.current = view
      setState({ kind: 'ready', view })
    } catch (error) {
      viewRef.current = null
      setState(kitErrorReason(error) === 'not_installed'
        ? { kind: 'not-installed', message: errorMessage(error) }
        : { kind: 'failed', message: errorMessage(error) })
    }
  }, [path])

  useEffect(() => {
    void open()
  }, [open])

  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(async () => {
      const current = viewRef.current
      if (!current) return
      try {
        const next = await getKitDocument(current.kitId, current.documentId)
        if (next.version !== current.version || next.dirty !== current.dirty) {
          viewRef.current = next
          setState({ kind: 'ready', view: next })
        }
      } catch (error) {
        const reason = kitErrorReason(error)
        if (reason === 'stopped' || reason === 'document_not_found') void open()
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, open])

  const run = async (command: 'edit.undo' | 'edit.redo') => {
    const view = viewRef.current
    if (!view) return
    setBusy(command === 'edit.undo' ? 'undo' : 'redo')
    try {
      const executed = await runKitCommand(view.kitId, view.documentId, command)
      viewRef.current = executed.document
      setState({ kind: 'ready', view: executed.document })
    } catch (error) {
      notify.error(t('photoKit.commandFailed'), { description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    const view = viewRef.current
    if (!view) return
    setBusy('save')
    try {
      const saved = await saveKitDocument(view.kitId, view.documentId)
      viewRef.current = saved
      setState({ kind: 'ready', view: saved })
      notify.success(t('photoKit.saved'))
    } catch (error) {
      notify.error(t('photoKit.saveFailed'), { description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="photo-kit-loading">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('photoKit.loading')}
      </div>
    )
  }

  if (state.kind !== 'ready') {
    return (
      <div className="flex h-full items-center justify-center p-8" data-testid="photo-kit-unavailable">
        <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
          <Layers className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-[15px] font-semibold text-foreground">
            {state.kind === 'not-installed' ? t('photoKit.notInstalledTitle') : t('photoKit.openFailed')}
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">{state.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void open()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('photoKit.retry')}
          </Button>
        </div>
      </div>
    )
  }

  const { view } = state
  const details = photoDetails(view)
  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="photo-kit-pane">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Layers className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
          <span className="truncate text-sm font-medium text-foreground">{filename}</span>
          {view.dirty ? (
            <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="photo-kit-unsaved">
              {t('photoKit.unsaved')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.undo')} title={t('photoKit.undo')}
            disabled={!view.canUndo || busy !== null} onClick={() => void run('edit.undo')}>
            <Undo2 className="size-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.redo')} title={t('photoKit.redo')}
            disabled={!view.canRedo || busy !== null} onClick={() => void run('edit.redo')}>
            <Redo2 className="size-4" aria-hidden="true" />
          </Button>
          <Button size="sm" className="ml-1" disabled={!view.dirty || busy !== null} onClick={() => void save()}>
            {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Save className="size-3.5" aria-hidden="true" />}
            {t('photoKit.save')}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-secondary/40 p-6">
          <img
            key={view.version}
            src={kitPreviewURL(view.kitId, view.documentId, view.version)}
            alt={filename}
            className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
            data-testid="photo-kit-preview"
          />
        </div>
        <aside className="flex w-60 shrink-0 flex-col border-l border-border" aria-label={t('photoKit.layers')}>
          <div className="border-b border-border px-3 py-2.5">
            <p className="text-[13px] font-semibold text-foreground">{t('photoKit.layers')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="photo-kit-summary">{view.summary}</p>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto py-1" data-testid="photo-kit-layers">
            {details?.layers.length ? details.layers.map((layer, index) => (
              <li key={`${index}:${layer.name}`} className={cn('flex items-center gap-2 px-3 py-1.5 text-[13px]', !layer.visible && 'text-muted-foreground')}>
                {layer.visible
                  ? <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  : <EyeOff className="size-3.5 shrink-0" aria-label={t('photoKit.hiddenLayer')} />}
                <span className="min-w-0 flex-1 truncate">{layer.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{layer.kind}</span>
              </li>
            )) : (
              <li className="px-3 py-2 text-[13px] text-muted-foreground">{t('photoKit.noLayers')}</li>
            )}
          </ul>
          <p className="border-t border-border px-3 py-2.5 text-xs text-muted-foreground">{t('photoKit.agentTip')}</p>
        </aside>
      </div>
    </div>
  )
}
