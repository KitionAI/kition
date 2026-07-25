import { Inbox, LoaderCircle, Plus, Sparkles, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { WorkflowLauncherTemplateCard } from '@/features/workflow/components/launcher/WorkflowLauncherTemplateCard'
import {
  getBuiltinTemplates,
  type WorkflowTemplate,
} from '@/features/workflow/templates'
import type { WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import { useEmailSyncCapability } from '@/features/emailSync/useTableEmailSyncWorkflows'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'

export type WorkspaceWorkflowCreateModeChoice =
  | { kind: 'template'; template: WorkflowTemplate; context: WorkflowRouteContext | null }
  | { kind: 'scratch'; context: WorkflowRouteContext | null }
  | { kind: 'chat'; context: WorkflowRouteContext | null }

type WorkspaceWorkflowCreateModeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-resolved table context. Surfaced in the dialog header so the user can
   *  confirm what scope the workflow will run against. When undefined the
   *  dialog still renders but no scope chip is shown — the caller is
   *  responsible for picking a table first (e.g. via the table picker dialog). */
  context: WorkflowRouteContext | null
  /** All tables in the active kitable. Multi-table kitables expose this as a
   *  source-table selector before the user chooses a template. */
  tableOptions?: WorkflowRouteContext[]
  /** Called when the user picks an option. The dialog handles its own close
   *  animation; the caller drives the next step (template fetch / AI route). */
  onSelect: (choice: WorkspaceWorkflowCreateModeChoice) => void
  /** Disables interactive choices while the caller's `onSelect` flow is still
   *  in flight (e.g. fetching the schema before the editor opens). */
  busyKind?: 'template' | 'chat' | 'scratch' | null
  /** Identifier for an in-flight template, so the matching card can show a
   *  spinner without affecting the rest of the grid. */
  busyTemplateId?: string
  errorMessage?: string | null
  emailSyncTablePath?: string
  onSelectEmailSync?: (tablePath: string) => void
}

const EMPTY_TABLE_OPTIONS: WorkflowRouteContext[] = []

/**
 * Mode chooser for creating an workflow from inside the workspace.
 *
 * Two surface paths reach this dialog:
 *   1. The "..." menu on a virtual `table://` leaf inside a `.kitable` — the
 *      caller pre-resolves `context` from the row, so no table picker is
 *      needed.
 *   2. The hideList Kitable Workflows landing page CTA — the caller may have
 *      to flow through `WorkspaceWorkflowTablePickerDialog` first when the
 *      kitable has multiple tables.
 *
 * Either way the dialog itself is "dumb": it surfaces the two options
 * (From a template / Created by chat (AI)) and emits the user's choice. The
 * caller decides what happens next (POST to /v1/workflows, open the AI
 * route, etc.).
 */
export function WorkspaceWorkflowCreateModeDialog({
  open,
  onOpenChange,
  context,
  tableOptions = EMPTY_TABLE_OPTIONS,
  onSelect,
  busyKind,
  busyTemplateId,
  errorMessage,
  emailSyncTablePath,
  onSelectEmailSync,
}: WorkspaceWorkflowCreateModeDialogProps) {
  type View = 'mode' | 'template'
  const [view, setView] = useState<View>('mode')
  const [selectedTableId, setSelectedTableId] = useState('')
  const { t } = useTranslation('workflow')

  // Reset back to the mode picker each time the dialog reopens so a previous
  // template view does not leak between distinct invocations.
  useEffect(() => {
    if (open) {
      setView('mode')
      setSelectedTableId(context?.tableId || tableOptions[0]?.tableId || '')
    }
  }, [open, context?.tableId, tableOptions])

  const effectiveContext = useMemo(() => {
    return tableOptions.find((item) => item.tableId === selectedTableId) || context
  }, [context, selectedTableId, tableOptions])
  const templates = useMemo(
    () => getBuiltinTemplates(t, { tableName: effectiveContext?.tableName }),
    [effectiveContext?.tableName, t],
  )
  const emailSyncAvailable = useEmailSyncCapability(open && Boolean(emailSyncTablePath))
  const showEmailSyncTemplate = Boolean(emailSyncTablePath && onSelectEmailSync && emailSyncAvailable)
  const templateCount = templates.length + (showEmailSyncTemplate ? 1 : 0)
  const disabled = Boolean(busyKind)

  return (
    <Dialog open={open} onOpenChange={(next) => (disabled ? null : onOpenChange(next))}>
      <DialogContent
        size="2xl"
        className="gap-0 p-0"
        data-testid="workspace-workflow-create-mode-dialog"
        data-context-table-name={effectiveContext?.tableName || ''}
        data-context-table-id={effectiveContext?.tableId || ''}
        data-context-document-id={effectiveContext?.documentId || ''}
      >
        <DialogHeader className="space-y-1.5 border-b px-6 py-4">
          <DialogTitle>
            {view === 'mode'
              ? t('launcher.createModeDialog.title')
              : t('launcher.createModeDialog.titleTemplateView')}
          </DialogTitle>
          <DialogDescription>
            {view === 'mode'
              ? effectiveContext?.tableName
                ? t('launcher.createModeDialog.descriptionWithScope', { scope: effectiveContext.tableName })
                : t('launcher.createModeDialog.descriptionDefault')
              : t('launcher.createModeDialog.descriptionTemplateView')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-5">
          {tableOptions.length > 1 ? (
            <label className="mb-4 block text-xs font-medium text-muted-foreground">
              <span className="mb-1.5 block">{t('launcher.createModeDialog.sourceTableLabel')}</span>
              <select
                className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
                value={selectedTableId}
                onChange={(event) => setSelectedTableId(event.target.value)}
                disabled={disabled}
                data-testid="workflow-create-source-table"
              >
                {tableOptions.map((option) => (
                  <option key={option.tableId} value={option.tableId}>{option.tableName}</option>
                ))}
              </select>
            </label>
          ) : null}
          {view === 'mode' ? (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-brand hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => setView('template')}
                disabled={disabled}
                data-testid="create-mode-template"
              >
                <span className="inline-grid size-9 shrink-0 place-items-center rounded-md bg-muted text-brand">
                  <Table2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block text-sm font-medium text-foreground">
                      {t('launcher.createModeDialog.modeTemplate.title')}
                    </span>
                    <span
                      className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-brand"
                      data-testid="create-mode-template-count"
                    >
                      {t('launcher.createModeDialog.modeTemplate.badge', { count: templateCount })}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t('launcher.createModeDialog.modeTemplate.subtitle')}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-brand hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => onSelect({ kind: 'chat', context: effectiveContext })}
                disabled={disabled}
                data-testid="create-mode-chat"
              >
                <span className="inline-grid size-9 shrink-0 place-items-center rounded-md bg-muted text-brand">
                  {busyKind === 'chat' ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t('launcher.createModeDialog.modeChat.title')}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t('launcher.createModeDialog.modeChat.subtitle')}
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <div
              data-testid="workspace-workflow-template-picker"
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              {/* Scratch card — semantically a "starting point" alongside the
               *  templates, so it lives inside the same grid (not above it).
               *  Visual hierarchy stays simple — same card shape, just a Plus
               *  icon + slate accent instead of the purple template chip — so
               *  users read it as "another way to start" rather than "broken
               *  template". */}
              <button
                type="button"
                onClick={() => { if (!disabled) onSelect({ kind: 'scratch', context: effectiveContext }) }}
                aria-disabled={disabled || busyKind === 'scratch'}
                disabled={disabled}
                data-testid="create-mode-scratch"
                className={`group flex h-full w-full flex-col items-stretch gap-3 rounded-xl border border-hairline-soft bg-card p-4 text-left transition-colors hover:border-brand/50 hover:shadow-soft ${busyKind === 'scratch' ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center">
                  <span className="grid size-7 place-items-center rounded-md bg-secondary text-muted-foreground">
                    <Plus className="size-4" />
                  </span>
                  {busyKind === 'scratch' ? (
                    <LoaderCircle className="ml-auto size-4 animate-spin text-brand" />
                  ) : null}
                </div>
                <span className="block text-sm font-medium text-foreground">
                  {t('launcher.createModeDialog.scratchCard.title')}
                </span>
                <span
                  className="-mt-1 block text-xs leading-relaxed text-muted-foreground"
                  data-testid="create-mode-scratch-description"
                >
                  {t('launcher.createModeDialog.scratchCard.description')}
                </span>
              </button>
              {templates.map((tpl) => (
                <WorkflowLauncherTemplateCard
                  key={tpl.id}
                  template={tpl}
                  busy={busyTemplateId === tpl.id}
                  showDescription
                  onSelect={(t) => onSelect({ kind: 'template', template: t, context: effectiveContext })}
                />
              ))}
              {showEmailSyncTemplate ? (
                <button
                  type="button"
                  data-testid="email-sync-workflow-template"
                  onClick={() => onSelectEmailSync(emailSyncTablePath!)}
                  className="group flex h-full w-full flex-col items-stretch gap-3 rounded-xl border border-border bg-card p-4 text-left card-interactive hover:border-primary/30 hover:shadow-soft"
                >
                  <div className="flex items-center">
                    <span className="grid size-7 place-items-center rounded-md bg-primary/15 text-primary">
                      <Inbox className="size-4" />
                    </span>
                    <span className="-ml-1.5 grid size-7 place-items-center rounded-md bg-tint-mint text-foreground">
                      <Table2 className="size-4" />
                    </span>
                  </div>
                  <span className="block text-sm font-medium text-foreground">Sync an email inbox</span>
                  <span className="-mt-1 block text-xs leading-relaxed text-muted-foreground">
                    Import IMAP messages into this table and save full content as Markdown.
                  </span>
                </button>
              ) : null}
            </div>
          )}

          {errorMessage ? (
            <div
              className="mt-3 rounded-md border border-destructive-border bg-destructive-background px-3 py-2 text-xs text-destructive-foreground"
              data-testid="workspace-workflow-create-mode-dialog-error"
            >
              {errorMessage}
            </div>
          ) : null}
        </div>

        <DialogFooter className="items-center border-t px-6 py-4 sm:justify-between">
          {view === 'template' ? (
            <button
              type="button"
              onClick={() => onSelect({ kind: 'chat', context: effectiveContext })}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand transition-colors hover:text-brand-active disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="workspace-workflow-template-picker-ai-cta"
            >
              <Sparkles className="size-3.5" />
              {t('launcher.createModeDialog.aiCta')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {view === 'template' ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setView('mode')}
                disabled={disabled}
              >
                {t('launcher.createModeDialog.back')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={disabled}
            >
              {t('launcher.createModeDialog.cancel')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
