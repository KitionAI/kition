import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'

export type WorkflowSaveBarProps = {
  dirty: boolean
  dirtyFields: string[]
  drawerOpen: boolean
  saving: boolean
  saveDisabled: boolean
  onDiscard: () => void
  onSave: () => void
}

/** The floating page save bar; it steps aside from the drawer so both save rows stay clickable. */
export function WorkflowSaveBar({ dirty, dirtyFields, drawerOpen, saving, saveDisabled, onDiscard, onSave }: WorkflowSaveBarProps) {
  const { t } = useTranslation('workflow')
  if (!dirty) return <div className="sr-only" data-testid="workflow-home-save-bar-hidden" />
  return (
    <div
      data-testid="workflow-home-save-bar"
      className={`absolute bottom-4 left-6 z-20 flex items-center justify-between rounded-xl bg-popover px-4 py-3 text-sm text-popover-foreground shadow-floating ${drawerOpen ? 'right-[376px]' : 'right-6'}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-warning" />
        <span className="truncate">{t('panels.drawer.pageSaveBar.messagePrefix', { fields: dirtyFields.join(', ') })}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" className="border-border bg-transparent text-popover-foreground hover:bg-muted/80" onClick={onDiscard} disabled={saving} data-testid="workflow-home-discard">
          {t('panels.drawer.pageSaveBar.discard')}
        </Button>
        <Button className="bg-primary hover:bg-primary/90" onClick={onSave} disabled={saveDisabled} data-testid="workflow-home-save">
          {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {t('panels.drawer.pageSaveBar.save')}
        </Button>
      </div>
    </div>
  )
}

export type WorkflowDrawerSaveRowProps = {
  validationErrorCount: number
  saving: boolean
  onDiscard: () => void
  onSave: () => void
}

/** The drawer footer while there are unsaved edits. */
export function WorkflowDrawerSaveRow({ validationErrorCount, saving, onDiscard, onSave }: WorkflowDrawerSaveRowProps) {
  const { t } = useTranslation('workflow')
  return (
    <div className="flex items-center gap-2" data-testid="workflow-drawer-save-row">
      <span className="size-2 shrink-0 rounded-full bg-warning" />
      <span className="flex-1 truncate text-[12px] text-muted-foreground">
        {validationErrorCount > 0
          ? t('panels.drawer.saveBar.validationErrors', { count: validationErrorCount })
          : t('panels.drawer.saveBar.unsavedEdits')}
      </span>
      <Button variant="outline" onClick={onDiscard} disabled={saving} data-testid="workflow-drawer-discard">
        {t('panels.drawer.saveBar.discard')}
      </Button>
      <Button className="bg-primary hover:bg-primary/90" onClick={onSave} disabled={validationErrorCount > 0 || saving} data-testid="workflow-drawer-save">
        {saving ? <LoaderCircle className="size-3 animate-spin" /> : null}
        {t('panels.drawer.saveBar.save')}
      </Button>
    </div>
  )
}
