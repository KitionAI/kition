import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createWorkflow } from '@/features/workflow/api'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import { openWorkflowHome, type WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { getBuiltinTemplates, type WorkflowTemplate } from '@/features/workflow/templates'
import type { TriggerTableOption } from '@/features/workflow/components/TriggerTableSelect'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { createTableWorkspaceEntry } from '@/features/table/lib/tableCreation'
import { notify } from '@/lib/notify'
import { WorkflowLauncherDecor } from './WorkflowLauncherDecor'
import { WorkflowLauncherHero, type LauncherView } from './WorkflowLauncherHero'
import { WorkflowLauncherTemplateGrid } from './WorkflowLauncherTemplateGrid'
import { WorkflowLauncherTemplateSheet } from './WorkflowLauncherTemplateSheet'

export interface WorkflowLauncherProps {
  tableContext: WorkflowRouteContext
  /** Called with the user's prompt and the effective (documentId,
   *  tableId, tableName) the AI should anchor the workflow on. When the
   *  launcher was mounted without a pre-bound table the tuple comes
   *  from the inline picker; otherwise it's the parent's tableContext
   *  unchanged. */
  onAiSubmit: (prompt: string, effectiveContext: WorkflowRouteContext) => void
  schemaLookup?: (documentId: string, tableId: string) => Promise<TableSchema>
  /** Which hero variant to mount initially. Defaults to 'gallery' (the
   *  legacy landing). Pass 'ai-prompt' to drop the user directly into the
   *  chat-first surface — used by the "Chat with AI" path coming
   *  from the workspace mode dialog so the second click isn't required. */
  initialView?: LauncherView
  /** Workspace root, forwarded to the inline AI-mode table picker so it
   *  scopes its lookup the same way the trigger drawer does. Undefined
   *  falls back to the cross-workspace fetch (used by tests + legacy
   *  modal mount). */
  rootPath?: string
}

export function WorkflowLauncher({ tableContext, onAiSubmit, schemaLookup, initialView = 'gallery', rootPath }: WorkflowLauncherProps) {
  const [view, setView] = useState<LauncherView>(initialView)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyTemplateId, setBusyTemplateId] = useState<string | undefined>(undefined)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Inline AI-mode table picker state. Only consulted when the caller
  // mounted us without a pre-bound table.
  const [pickedTableId, setPickedTableId] = useState('')
  // Tracks the "create your first kitable" CTA shown when the picker
  // has zero options. createTableWorkspaceEntry hits the data document
  // API + dispatches kition:data-document:table:create, which
  // useWorkflowTableLabels listens for and refreshes the picker
  // automatically. We auto-select the freshly-created table so the
  // user can submit immediately.
  const [creatingFirstTable, setCreatingFirstTable] = useState(false)

  const { t } = useTranslation('workflow')
  const templates = getBuiltinTemplates(t, { tableName: tableContext.tableName })
  const needsTablePicker = !tableContext.tableId
  const { labels: tableLabels } = useWorkflowTableLabels(needsTablePicker ? rootPath : undefined)
  const tablePickerOptions = useMemo<TriggerTableOption[]>(() => {
    if (!needsTablePicker) return []
    return Object.entries(tableLabels)
      .map(([tableId, label]) => ({
        tableId,
        tableName: label.tableName,
        documentTitle: label.documentTitle,
      }))
      .sort((a, b) => {
        const doc = a.documentTitle.localeCompare(b.documentTitle)
        if (doc !== 0) return doc
        return a.tableName.localeCompare(b.tableName)
      })
  }, [needsTablePicker, tableLabels])

  useEffect(() => {
    if (view !== 'ai-prompt') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setView('gallery')
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [view])

  // kition:workflow:model-missing fires from WorkflowNewPage.handleAiSubmit
  // when the desktop settings don't have a writing model configured. The
  // event used to disappear into the void, so the Start button silently
  // no-op'd and the user thought it was broken. Surface a persistent
  // error toast with an inline "Configure" CTA that pops the Settings →
  // Models pane via kition:settings:open (handled in Shell). Also surface
  // a plain inline copy in the hero's red banner as a fallback for tests
  // / hosts where the toast root isn't mounted yet.
  useEffect(() => {
    function onMissing() {
      const msg = t('launcher.hero.aiPromptModelMissing')
      setErrorMessage(msg)
      notify.persistentError(
        msg,
        {
          label: t('launcher.hero.aiPromptModelMissingCta'),
          onClick: () => {
            window.dispatchEvent(new CustomEvent('kition:settings:open', { detail: { section: 'models' } }))
          },
        },
        { id: 'workflow-launcher-model-missing' },
      )
    }
    window.addEventListener('kition:workflow:model-missing', onMissing)
    return () => window.removeEventListener('kition:workflow:model-missing', onMissing)
  }, [t])

  const handleAiSubmit = useCallback(() => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    if (needsTablePicker) {
      if (!pickedTableId) return
      const label = tableLabels[pickedTableId]
      if (!label) return
      onAiSubmit(trimmed, {
        documentId: label.documentId,
        tableId: pickedTableId,
        tableName: label.tableName,
      })
      return
    }
    onAiSubmit(trimmed, tableContext)
  }, [prompt, needsTablePicker, pickedTableId, tableLabels, tableContext, onAiSubmit])

  const handleCreateFirstTable = useCallback(async () => {
    if (creatingFirstTable) return
    if (!rootPath) {
      // Without a workspace root we don't know where to put the kitable
      // marker. The launcher only mounts the picker when rootPath is
      // bound, so this is a guard for hostile callers — surface the
      // error so the user isn't left wondering why nothing happened.
      setErrorMessage(t('errors.createWorkflow'))
      return
    }
    setCreatingFirstTable(true)
    setErrorMessage(null)
    try {
      const result = await createTableWorkspaceEntry({ rootPath })
      // tableCreation skips the kition:data-document:table:create dispatch
      // (it's intended for sidebar paths that own a richer wiring).
      // Fire it here so useWorkflowTableLabels refreshes and the
      // picker shows the new option without manual reload.
      if (result.tableId != null) {
        window.dispatchEvent(new CustomEvent('kition:data-document:table:create', {
          detail: { vaultPath: result.document.path, tableId: result.tableId },
        }))
        // Pre-select the new table so Submit goes from disabled to
        // enabled the moment the prompt has text. The user just made
        // this table; picking it for them respects their intent.
        setPickedTableId(String(result.tableId))
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('errors.createWorkflow'))
    } finally {
      setCreatingFirstTable(false)
    }
  }, [creatingFirstTable, rootPath, t])

  const handleStartScratch = useCallback(async () => {
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const def = await createWorkflow({
        name: 'Untitled workflow',
        description: '',
        enabled: false,
        trigger: { type: 'record_created', documentId: tableContext.documentId, tableId: tableContext.tableId },
        action: {
          type: 'send_email',
          connectionId: '',
          to: 'you@example.com',
          subject: { parts: [{ kind: 'text', text: 'New record' }] },
          body: { parts: [{ kind: 'text', text: 'A new record was created.' }] },
        },
      })
      openWorkflowHome({ workflowId: def.id })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('errors.createWorkflow'))
    } finally {
      setSubmitting(false)
    }
  }, [tableContext, t])

  const handleTemplateSelect = useCallback(async (tpl: WorkflowTemplate) => {
    setBusyTemplateId(tpl.id)
    setErrorMessage(null)
    try {
      const schema = schemaLookup ? await schemaLookup(tableContext.documentId, tableContext.tableId).catch(() => null) : null
      const { input, unresolvedFieldNames } = createWorkflowFromTemplate(tpl, {
        documentId: tableContext.documentId,
        tableId: tableContext.tableId,
        tableName: tableContext.tableName,
        schema,
      })
      const def = await createWorkflow(input)
      // Hand the post-creation page a hint about template fields the
      // schema couldn't bind so it can banner the user instead of letting
      // the fallback text masquerade as user intent. The hint is small
      // and one-shot, so a sessionStorage handoff is enough — survives
      // the navigation but doesn't pollute the URL or persist beyond the
      // next reload.
      if (unresolvedFieldNames.length > 0) {
        try {
          window.sessionStorage.setItem(
            `kition:workflow:template-unresolved:${def.id}`,
            JSON.stringify(unresolvedFieldNames),
          )
        } catch {
          // sessionStorage may be unavailable in some Electron contexts;
          // the banner is non-critical so we silently skip.
        }
      }
      openWorkflowHome({ workflowId: def.id })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('errors.applyTemplate'))
    } finally {
      setBusyTemplateId(undefined)
    }
  }, [schemaLookup, tableContext, t])

  const handleAgentClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('kition:assistant:open', {
      detail: {
        source: 'workflow-launcher',
        tableContext,
        seed: `Help me design an workflow for ${tableContext.tableName}.`,
      },
    }))
  }, [tableContext])

  return (
    <div data-testid="workflow-launcher" className="min-h-full bg-background px-8 py-12 lg:px-16">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <WorkflowLauncherHero
          view={view}
          tableName={tableContext.tableName}
          prompt={prompt}
          submitting={submitting}
          errorMessage={errorMessage}
          onPromptChange={setPrompt}
          onSwitchToAiPrompt={() => setView('ai-prompt')}
          onSwitchToGallery={() => setView('gallery')}
          onAiSubmit={handleAiSubmit}
          onStartFromScratch={handleStartScratch}
          tablePicker={needsTablePicker ? {
            options: tablePickerOptions,
            pickedTableId,
            onPick: setPickedTableId,
            emptyState: rootPath ? {
              onCreate: () => { void handleCreateFirstTable() },
              busy: creatingFirstTable,
            } : undefined,
          } : undefined}
        />
        <WorkflowLauncherDecor />
      </div>

      <div className="mx-auto max-w-[1080px]">
        <WorkflowLauncherTemplateGrid
          templates={templates}
          busyTemplateId={busyTemplateId}
          onSelect={handleTemplateSelect}
          onExploreMore={() => setSheetOpen(true)}
          onAgentClick={handleAgentClick}
        />
      </div>

      <WorkflowLauncherTemplateSheet
        open={sheetOpen}
        templates={templates}
        onSelect={(tpl) => { setSheetOpen(false); void handleTemplateSelect(tpl) }}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  )
}
