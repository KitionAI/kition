import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Redo2, RefreshCw, Save, Sparkles, Undo2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui'
import type { useKitDocument } from '../sdk/useKitDocument'
import type { useKitEditor } from '../sdk/useKitEditor'
import { commandForShortcut } from '../sdk/kitShortcuts'
import { KitMenuBar } from './KitMenuBar'

type KitEditorFrameProps = {
  document: ReturnType<typeof useKitDocument<unknown>>
  editor: ReturnType<typeof useKitEditor>
  /** The file name shown in the header. */
  title: string
  icon: LucideIcon
  /** Top-level menus in display order, and their shown names. */
  menuOrder: readonly string[]
  menuLabel?: (label: string) => string
  /** The bar under the menus: the active tool's options. */
  options?: ReactNode
  /** The column left of the canvas: tools. */
  tools?: ReactNode
  /** The column right of the canvas: panels. */
  side?: ReactNode
  /** The left side of the status bar; `statusEnd` is the right side. */
  status?: ReactNode
  statusEnd?: ReactNode
  /** The kit's own keys; they come first. The frame then handles Save and every command's shortcut. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** The canvas, shown once the document is open. */
  children: ReactNode
}

/**
 * The editor every in-page kit shares: the header with the file, undo, redo,
 * Ask agent, and Save; the kit's menus; the options bar; tools, canvas, and
 * panels; the status bar; the opening, failure, and changed-on-disk states;
 * and the shortcuts of the kit's commands. A kit supplies its tools, panels,
 * and canvas.
 */
export function KitEditorFrame(props: KitEditorFrameProps) {
  const { document, editor, title, icon: Icon } = props
  const { t } = useTranslation('workspace')

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    // The kit's own keys first (tools, Enter and Escape), then Save, then the kit's command shortcuts.
    props.onKeyDown?.(event)
    if (event.defaultPrevented) return
    const command = event.metaKey || event.ctrlKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void editor.save()
      return
    }
    const shortcut = commandForShortcut(editor.commands, event)
    if (!shortcut) return
    event.preventDefault()
    void editor.run(shortcut.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background outline-none" tabIndex={-1} onKeyDown={keyDown} data-testid="kit-editor">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {document.dirty ? (
          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="kit-unsaved">
            {t('kitEditor.unsaved')}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('kitEditor.undo')} title={t('kitEditor.undo')} disabled={!document.info?.canUndo} onClick={() => void editor.run('edit.undo')}>
          <Undo2 className="size-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('kitEditor.redo')} title={t('kitEditor.redo')} disabled={!document.info?.canRedo} onClick={() => void editor.run('edit.redo')}>
          <Redo2 className="size-4" aria-hidden="true" />
        </Button>
        {editor.canAskAgent ? (
          <Button variant="ghost" size="sm" onClick={() => void editor.askAgent()} data-testid="kit-ask-agent">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('kitEditor.askAgent')}
          </Button>
        ) : null}
        <Button size="sm" disabled={!document.dirty || document.saving} onClick={() => void editor.save()} data-testid="kit-save">
          {document.saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Save className="size-3.5" aria-hidden="true" />}
          {t('kitEditor.save')}
        </Button>
      </div>
      <KitMenuBar commands={editor.commands} onRun={(command) => void editor.run(command.id)} onOpen={editor.refreshCommands} order={props.menuOrder} menuLabel={props.menuLabel} />
      {props.options}
      <div className="flex min-h-0 flex-1">
        {props.tools}
        <div className="relative min-w-0 flex-1 bg-secondary/40" data-testid="kit-canvas-region">
          {document.conflict ? (
            <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-sm" role="alert" data-testid="kit-file-changed">
              <p className="min-w-0 flex-1 text-[13px] text-foreground">{t('kitEditor.changedOnDisk')}</p>
              <Button variant="outline" size="sm" onClick={document.keepMine}>{t('kitEditor.keepMine')}</Button>
              <Button size="sm" onClick={document.reopen} data-testid="kit-file-reload">{t('kitEditor.reloadFile')}</Button>
            </div>
          ) : null}
          {document.failure ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
                <p className="text-[15px] font-semibold text-foreground">{t('kitEditor.openFailed')}</p>
                <p className="mt-2 text-[13px] text-muted-foreground">{document.failure}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={document.reopen}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t('kitEditor.reopen')}
                </Button>
              </div>
            </div>
          ) : document.doc && document.state ? props.children : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="kit-opening">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t('kitEditor.opening')}
            </div>
          )}
        </div>
        {props.side}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground" data-testid="kit-status-bar">
        {props.status}
        <div className="flex-1" />
        {props.statusEnd}
      </div>
    </div>
  )
}
