import { ChevronLeft, LoaderCircle, Play, Plus, RefreshCw, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WorkflowDefinition } from '@/api/workflows'
import { Button } from '@/components/ui'
import { SampleRowPicker } from '@/features/workflow/components/SampleRowPicker'
import { WorkflowStatusToggle } from '@/features/workflow/components/WorkflowStatusToggle'
import { parseIdAsNumber } from '@/features/workflow/lib/workflowDraft'
import { WorkflowHomeActionsMenu, type WorkflowDetailView } from '@/features/workflow/pages/WorkflowHomeActionsMenu'

const RECORD_TRIGGER_TYPES = new Set(['record_created', 'record_updated', 'record_created_or_updated'])

export type WorkflowDetailTopbarProps = {
  selected: WorkflowDefinition
  hideClose: boolean
  scopedKitablePath?: string
  streamLocked: boolean
  onClose: () => void
  toggle: { saving: boolean; onToggle: (next: boolean) => void }
  /** Run-test controls show only for email actions. */
  runTest: { visible: boolean; running: boolean; blocked: boolean; onRun: () => void; onRunWithRow: (values: Record<string, unknown>) => void }
  save: { disabled: boolean; saving: boolean; onSave: () => void }
  actions: { activeView: WorkflowDetailView; deleting: boolean; onSelectView: (view: WorkflowDetailView) => void; onDelete: () => void }
}

/** One bar for the open workflow: back, on/off, run test, save, and the More menu. The workspace already names the workflow, so this bar does not. */
export function WorkflowDetailTopbar({ selected, hideClose, scopedKitablePath, streamLocked, onClose, toggle, runTest, save, actions }: WorkflowDetailTopbarProps) {
  const { t } = useTranslation('workflow')
  const runDisabled = streamLocked || runTest.running || runTest.blocked
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 text-sm ${scopedKitablePath ? 'h-14' : 'h-12'}`}
      data-testid="workflow-home-topbar"
    >
      {hideClose ? null : (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          aria-label={t('panels.home.closeAria')}
          data-testid="workflow-home-back"
        >
          <ChevronLeft className="size-4" />
          <span className="truncate max-w-[160px]">{t('panels.home.h1')}</span>
        </button>
      )}
      <WorkflowStatusToggle enabled={selected.enabled} saving={toggle.saving} onToggle={toggle.onToggle} disabled={streamLocked} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {runTest.visible ? (
          <>
            <Button variant="outline" onClick={runTest.onRun} disabled={runDisabled} data-testid="workflow-home-run-test">
              {runTest.running ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
              {t('panels.home.runTest')}
            </Button>
            {RECORD_TRIGGER_TYPES.has(selected.trigger.type) ? (
              <SampleRowPicker
                documentId={parseIdAsNumber(selected.trigger.documentId)}
                tableId={parseIdAsNumber(selected.trigger.tableId)}
                disabled={runDisabled}
                onPick={(values) => runTest.onRunWithRow(values)}
              />
            ) : null}
          </>
        ) : null}
        <Button onClick={save.onSave} disabled={save.disabled} data-testid="workflow-home-save-topbar">
          {save.saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          {t('panels.home.save')}
        </Button>
        <WorkflowHomeActionsMenu
          activeView={actions.activeView}
          labels={{
            moreActions: t('panels.home.moreActions'),
            configuration: t('panels.home.tabConfiguration'),
            history: t('panels.home.tabRunHistory'),
            logs: t('panels.home.tabLogs'),
            delete: t('panels.home.delete'),
          }}
          deleting={actions.deleting}
          deleteDisabled={streamLocked || actions.deleting}
          onSelectView={actions.onSelectView}
          onDelete={actions.onDelete}
        />
      </div>
    </div>
  )
}

export type WorkflowIndexTopbarProps = {
  hideClose: boolean
  breadcrumbLeft: string
  breadcrumbRight: string
  stats: { total: number; active: number }
  onClose: () => void
  onRefresh: () => void
  onCreate: () => void
}

/** The bar shown when no workflow is open: breadcrumb, counts, refresh, and create. */
export function WorkflowIndexTopbar({ hideClose, breadcrumbLeft, breadcrumbRight, stats, onClose, onRefresh, onCreate }: WorkflowIndexTopbarProps) {
  const { t } = useTranslation('workflow')
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-5 text-sm">
        <span className="truncate text-muted-foreground">{breadcrumbLeft}</span>
        <span className="text-muted-foreground/60">/</span>
        <span className="truncate font-medium">{breadcrumbRight}</span>
        {hideClose ? null : (
          <button type="button" className="ml-auto inline-grid size-8 place-items-center rounded-lg hover:bg-muted" onClick={onClose} aria-label={t('panels.home.closeAria')}>
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{t('panels.home.h1')}</h1>
          <span className="rounded-lg bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('panels.home.stats', stats)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="inline-grid size-8 place-items-center rounded-lg border border-border bg-card hover:bg-muted/40" onClick={onRefresh} aria-label={t('panels.home.refreshAria')}>
            <RefreshCw className="size-4" />
          </button>
          <Button className="h-8 bg-primary px-3 hover:bg-primary/90" onClick={onCreate} data-testid="workflow-home-create">
            <Plus className="size-4" />
            {t('panels.home.create')}
          </Button>
        </div>
      </div>
    </>
  )
}
