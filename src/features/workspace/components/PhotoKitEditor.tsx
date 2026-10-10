import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, Loader2, Redo2, RefreshCw, Save, Sparkles, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { notify } from '@/lib/notify'
import { kitPreviewURL, photoDetails, runKitCommand, saveKitDocument } from '@/api/kits'
import { PhotoMenuBar } from './photo/PhotoMenuBar'
import { PhotoOptionsBar } from './photo/PhotoOptionsBar'
import { PhotoSidePanel } from './photo/PhotoSidePanel'
import { PhotoToolRail } from './photo/PhotoToolRail'
import { usePhotoSurface } from './photo/usePhotoSurface'

type PhotoKitEditorProps = {
  path: string
  active: boolean
  onOpenAgent?: () => void
  /** The editor cannot be embedded here; the tab falls back to its preview. */
  onUnavailable: () => void
}

/**
 * A layered image in the Photo kit, with Kition drawing the editor: menus
 * built from the kit's commands, the tool rail, the options bar, the layers
 * and properties panel, and the status bar. Only the canvas is the kit's own
 * native view, kept exactly over the content area in the middle.
 */
export function PhotoKitEditor({ path, active, onOpenAgent, onUnavailable }: PhotoKitEditorProps) {
  const { t } = useTranslation('workspace')
  const { regionRef, view, setView, commands, refreshCommands, failure, reopen, snapshotVersion } = usePhotoSurface({
    path,
    active,
    onUnavailable,
    closedMessage: t('photoKit.editorClosed'),
  })
  const details = view ? photoDetails(view) : null

  const run = useCallback(async (command: string, params: Record<string, unknown> = {}) => {
    if (!view) return
    try {
      const executed = await runKitCommand(view.kitId, view.documentId, command, params)
      setView(executed.document)
    } catch (error) {
      notify.error(t('photoKit.commandFailed'), { description: error instanceof Error ? error.message : String(error) })
    }
  }, [setView, t, view])

  const save = useCallback(async () => {
    if (!view) return
    try {
      setView(await saveKitDocument(view.kitId, view.documentId))
      notify.success(t('photoKit.saved'))
    } catch (error) {
      notify.error(t('photoKit.saveFailed'), { description: error instanceof Error ? error.message : String(error) })
    }
  }, [setView, t, view])

  const filename = path.split('/').filter(Boolean).pop() || path
  const zoom = typeof details?.zoom === 'number' ? Math.round(details.zoom * 100) : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="photo-kit-editor">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Layers className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-foreground">{filename}</span>
        {view?.dirty ? (
          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="photo-kit-unsaved">
            {t('photoKit.unsaved')}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.undo')} title={t('photoKit.undo')} disabled={!view?.canUndo} onClick={() => void run('edit.undo')}>
          <Undo2 className="size-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.redo')} title={t('photoKit.redo')} disabled={!view?.canRedo} onClick={() => void run('edit.redo')}>
          <Redo2 className="size-4" aria-hidden="true" />
        </Button>
        {onOpenAgent ? (
          <Button variant="ghost" size="sm" onClick={onOpenAgent} data-testid="photo-kit-ask-agent">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('photoKit.askAgent')}
          </Button>
        ) : null}
        <Button size="sm" disabled={!view?.dirty} onClick={() => void save()} data-testid="photo-kit-save">
          <Save className="size-3.5" aria-hidden="true" />
          {t('photoKit.save')}
        </Button>
      </div>
      <PhotoMenuBar commands={commands} onRun={(command) => void run(command.id)} onOpen={refreshCommands} />
      <PhotoOptionsBar details={details} onSet={(settings) => void run('ui.set', settings)} />
      <div className="flex min-h-0 flex-1">
        <PhotoToolRail tool={details?.tool} foreground={details?.foreground} background={details?.background} onSelect={(tool) => void run('ui.set', { tool })} />
        <div ref={regionRef} className="relative min-w-0 flex-1 bg-secondary/40" data-testid="photo-kit-editor-region">
          {view && snapshotVersion != null ? (
            <img
              src={kitPreviewURL(view.kitId, view.documentId, snapshotVersion)}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 size-full object-fill"
              data-testid="photo-canvas-snapshot"
            />
          ) : null}
          {failure ? (
            <div className="relative flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
                <p className="text-[15px] font-semibold text-foreground">{t('photoKit.openFailed')}</p>
                <p className="mt-2 text-[13px] text-muted-foreground">{failure}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={reopen}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t('photoKit.reopen')}
                </Button>
              </div>
            </div>
          ) : view ? null : (
            <div className="relative flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t('photoKit.openingEditor')}
            </div>
          )}
        </div>
        <PhotoSidePanel details={details} onRun={(command, params) => void run(command, params)} />
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground" data-testid="photo-status-bar">
        <span>{view?.summary ?? ''}</span>
        <div className="flex-1" />
        {zoom != null ? <span className="tabular-nums">{zoom}%</span> : null}
      </div>
    </div>
  )
}
