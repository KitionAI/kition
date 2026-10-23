import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createWorkflow } from '@/api/workflows'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import { openWorkflowHome, type WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { getBuiltinTemplates, type WorkflowTemplate } from '@/features/workflow/templates'
import type { TriggerTableOption } from '@/features/workflow/components/TriggerTableSelect'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { createTableFile, listTableFiles, notifyTableFilesChanged, TABLE_FILE_EXTENSION, tableKey } from '@/api/kitTables'
import { notify } from '@/lib/notify'
import { WorkflowLauncherDecor } from './WorkflowLauncherDecor'
import { WorkflowLauncherHero, type LauncherView } from './WorkflowLauncherHero'
import { WorkflowLauncherTemplateGrid } from './WorkflowLauncherTemplateGrid'
import { WorkflowLauncherTemplateSheet } from './WorkflowLauncherTemplateSheet'

export interface WorkflowLauncherProps {
  tableContext: WorkflowRouteContext
  /** Called with the user's prompt and the effective (documentPath,
   *  tableId, tableName) the AI should anchor the workflow on. When the
   *  launcher was mounted without a pre-bound table the tuple comes
   *  from the inline picker; otherwise it's the parent's tableContext
   *  unchanged. */
  onAiSubmit: (prompt: string, effectiveContext: WorkflowRouteContext) => void
  schemaLookup?: (documentPath: string, tableId: string) => Promise<TableSchema>
  /** Which hero variant to mount initially. Defaults to 'gallery' (the
   *  legacy landing). Pass 'ai-prompt' to drop the user directly into the
   *  chat-first surface — used by the "Chat with AI" path coming
   *  from the workspace mode dialog so the second click isn't required. */
  initialView?: LauncherView
  /** Workspace root. Kept for callers; the table picker always lists the
   *  open workspace's table files. */
  rootPath?: string
}

/** `Untitled table.ktable`, or `Untitled table 2.ktable`, ... — the first name no file in `taken` has. */
export function unusedUntitledTablePath(taken: readonly string[]): string {
  const used = new Set(taken.map((path) => path.toLowerCase()))
  for (let index = 1; ; index += 1) {
    const path = `Untitled table${index === 1 ? '' : ` ${index}`}${TABLE_FILE_EXTENSION}`
    if (!used.has(path.toLowerCase())) return path
  }
}

export function WorkflowLauncher({ tableContext, onAiSubmit, schemaLookup, initialView = 'gallery' }: WorkflowLauncherProps) {
  const [view, setView] = useState<LauncherView>(initialView)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyTemplateId, setBusyTemplateId] = useState<string | undefined>(undefined)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Inline AI-mode table picker state. Only consulted when the caller
  // mounted us without a pre-bound table.
  // The picked table's key: tableKey(path, tableId).
  const [pickedTableKey, setPickedTableKey] = useState('')
  // Tracks the "create your first table" CTA shown when the picker has
  // zero options. It creates an unused `Untitled table.ktable` and calls
  // notifyTableFilesChanged, which useWorkflowTableLabels listens for to
  // refresh the picker. We auto-select the freshly-created table so the
  // user can submit immediately.
  const [creatingFirstTable, setCreatingFirstTable] = useState(false)

  const { t } = useTranslation('workflow')
  const templates = getBuiltinTemplates(t, { tableName: tableContext.tableName })
  const needsTablePicker = !tableContext.tableId
  const { labels: tableLabels } = useWorkflowTableLabels()
  const tablePickerOptions = useMemo<TriggerTableOption[]>(() => {
    if (!needsTablePicker) return []
    return Object.entries(tableLabels)
      .map(([key, label]) => ({
        key,
        tableId: label.tableId,
        tableName: label.tableName,
        documentTitle: label.documentTitle,
        documentPath: label.documentPath,
        documentId: label.documentId,
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
      if (!pickedTableKey) return
      const label = tableLabels[pickedTableKey]
      if (!label) return
      onAiSubmit(trimmed, {
        documentPath: label.documentPath,
        tableId: label.tableId,
        tableName: label.tableName,
      })
      return
    }
    onAiSubmit(trimmed, tableContext)
  }, [prompt, needsTablePicker, pickedTableKey, tableLabels, tableContext, onAiSubmit])

  const handleCreateFirstTable = useCallback(async () => {
    if (creatingFirstTable) return
    setCreatingFirstTable(true)
    setErrorMessage(null)
    try {
      const existing = await listTableFiles()
      const path = unusedUntitledTablePath([
        ...(existing.files || []).map((file) => file.path),
        ...(existing.unreadable || []).map((file) => file.path),
      ])
      const result = await createTableFile(path)
      // useWorkflowTableLabels refreshes on this, so the picker shows the
      // new option without a manual reload.
      notifyTableFilesChanged(result.path)
      const firstTable = result.tables?.[0]
      if (firstTable) {
        // Pre-select the new table so Submit goes from disabled to
        // enabled the moment the prompt has text. The user just made
        // this table; picking it for them respects their intent.
        setPickedTableKey(tableKey(result.path, firstTable.id))
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('errors.createWorkflow'))
    } finally {
      setCreatingFirstTable(false)
    }
  }, [creatingFirstTable, t])

  const handleStartScratch = useCallback(async () => {
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const def = await createWorkflow({
        name: 'Untitled workflow',
        description: '',
        enabled: false,
        trigger: { type: 'record_created', documentPath: tableContext.documentPath, tableId: tableContext.tableId },
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
      const schema = schemaLookup ? await schemaLookup(tableContext.documentPath, tableContext.tableId).catch(() => null) : null
      const { input, unresolvedFieldNames } = createWorkflowFromTemplate(tpl, {
        documentPath: tableContext.documentPath,
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
          // sessionStorage may be unavailable in some embedded web views;
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
            pickedTableKey,
            onPick: setPickedTableKey,
            emptyState: {
              onCreate: () => { void handleCreateFirstTable() },
              busy: creatingFirstTable,
            },
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
