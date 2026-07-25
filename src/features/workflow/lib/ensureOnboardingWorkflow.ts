import { createDataTable, listDataDocuments } from '@/api/dataDocuments'
import {
  createWorkflow,
  patchWorkflow,
  type CreateWorkflowInput,
  type WorkflowDefinition,
} from '@/features/workflow/api'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import { fetchWorkflowTableSchema } from '@/features/workflow/lib/workflowTableSchema'
import { getBuiltinTemplates } from '@/features/workflow/templates'
import { getOnboardingWorkflowTemplate } from '@/features/workflow/templates/onboarding'
import type { DataTableSeed } from '@/types/dataDocument'

const LEGACY_CONTENT_MARKER_VERSION = 1
const MARKER_VERSION = 2

type OnboardingWorkflowStorage = Pick<Storage, 'getItem' | 'setItem'>

type OnboardingScenario = {
  id: string
  templateId: string
  sourceTableName: string
  targetTableName: string
  pathSuffix?: string
  targetTableSeed?: DataTableSeed
  legacyContentMarker?: boolean
  actionType?: string
  allowDisabledDraft?: boolean
}

const ONBOARDING_SCENARIOS: OnboardingScenario[] = [
  {
    id: 'lead-submission-email',
    templateId: 'lead-submission-email',
    sourceTableName: 'Leads',
    targetTableName: 'Leads',
    pathSuffix: 'Guides/Lead Automation/Lead Follow-up.kitable',
    actionType: 'send_email',
    allowDisabledDraft: true,
  },
  {
    id: 'content-idea-to-publishing-queue',
    templateId: 'content-idea-to-publishing-queue',
    sourceTableName: 'Content Ideas',
    targetTableName: 'Publishing Queue',
    legacyContentMarker: true,
  },
  {
    id: 'archive-completed-tasks',
    templateId: 'archive-completed-tasks',
    sourceTableName: 'Tasks',
    targetTableName: 'Completed Tasks',
    targetTableSeed: {
      title: 'Completed Tasks',
      name: 'completed_tasks',
      fields: [
        { title: 'Task', name: 'task', type: 'text', primary: true, required: true },
        { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['Todo', 'In Progress', 'Done'] } },
        { title: 'Due', name: 'due', type: 'date' },
        { title: 'Notes', name: 'notes', type: 'long_text' },
        { title: 'Automation Note', name: 'automation_note', type: 'long_text' },
      ],
      views: [{ title: 'Archive', type: 'grid' }],
    },
  },
  {
    id: 'weekday-priority-planning',
    templateId: 'weekday-priority-planning',
    sourceTableName: 'Tasks',
    targetTableName: 'Tasks',
  },
  {
    id: 'reading-progress-journal',
    templateId: 'reading-progress-journal',
    sourceTableName: 'Reading List',
    targetTableName: 'Reading Journal',
    targetTableSeed: {
      title: 'Reading Journal',
      name: 'reading_journal',
      fields: [
        { title: 'Article', name: 'article', type: 'text', primary: true, required: true },
        { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['Unread', 'Reading', 'Read'] } },
        { title: 'Source URL', name: 'source_url', type: 'url' },
        { title: 'Journal Note', name: 'journal_note', type: 'long_text' },
      ],
      views: [{ title: 'Journal', type: 'grid' }],
    },
  },
  {
    id: 'expense-high-value-review',
    templateId: 'expense-high-value-review',
    sourceTableName: 'Expenses',
    targetTableName: 'Expenses',
    actionType: 'update_record',
  },
  {
    id: 'order-catalog-enrichment',
    templateId: 'order-catalog-enrichment',
    sourceTableName: 'Orders',
    targetTableName: 'Product Catalog',
    actionType: 'lookup_record',
  },
  {
    id: 'normalize-contact-details',
    templateId: 'normalize-contact-details',
    sourceTableName: 'Contacts',
    targetTableName: 'Contacts',
    actionType: 'transform_record',
  },
]

export interface EnsureOnboardingWorkflowInput {
  scopedKitablePath: string
  rootPath?: string
  workflows: WorkflowDefinition[]
  translate: (key: string) => string
}

export interface EnsureOnboardingWorkflowDeps {
  listDocuments: typeof listDataDocuments
  createTable: typeof createDataTable
  fetchSchema: typeof fetchWorkflowTableSchema
  create: typeof createWorkflow
  patch: typeof patchWorkflow
  storage: OnboardingWorkflowStorage | null
}

export interface EnsureOnboardingWorkflowResult {
  created: WorkflowDefinition[]
  existing: WorkflowDefinition[]
}

const inFlight = new Map<string, Promise<EnsureOnboardingWorkflowResult>>()

const defaultDeps: Omit<EnsureOnboardingWorkflowDeps, 'storage'> = {
  listDocuments: listDataDocuments,
  createTable: createDataTable,
  fetchSchema: fetchWorkflowTableSchema,
  create: createWorkflow,
  patch: patchWorkflow,
}

/**
 * Materialises every runnable onboarding scenario that belongs to the active
 * table file. Missing target tables are created for onboarding packs copied by an
 * older Kition version. Per-scenario markers preserve intentional deletes.
 */
export function ensureOnboardingWorkflow(
  input: EnsureOnboardingWorkflowInput,
  overrides: Partial<EnsureOnboardingWorkflowDeps> = {},
): Promise<EnsureOnboardingWorkflowResult> {
  const key = `${input.rootPath || ''}\u0000${input.scopedKitablePath}`
  const current = inFlight.get(key)
  if (current) return current

  const deps: EnsureOnboardingWorkflowDeps = {
    ...defaultDeps,
    storage: browserStorage(),
    ...overrides,
  }
  const promise = ensureOnboardingWorkflowsOnce(input, deps)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function ensureOnboardingWorkflowsOnce(
  input: EnsureOnboardingWorkflowInput,
  deps: EnsureOnboardingWorkflowDeps,
): Promise<EnsureOnboardingWorkflowResult> {
  const docs = await deps.listDocuments(
    input.rootPath ? { workspace_root: input.rootPath } : undefined,
  )
  const document = (docs.items || []).find(
    (item) => normalizePath(String(item.path || '')) === normalizePath(input.scopedKitablePath),
  )
  if (!document?.id) return { created: [], existing: [] }

  const documentId = String(document.id)
  const tables = [...(document.tables || [])]
  const created: WorkflowDefinition[] = []
  const existing: WorkflowDefinition[] = []

  for (const scenario of ONBOARDING_SCENARIOS) {
    if (scenario.pathSuffix && !pathEndsWith(input.scopedKitablePath, scenario.pathSuffix)) {
      continue
    }
    const source = findTable(tables, scenario.sourceTableName)
    if (!source) continue

    const marker = markerKey(input.rootPath, documentId, scenario.id)
    const legacyMarker = scenario.legacyContentMarker
      ? legacyContentMarkerKey(input.rootPath, documentId)
      : ''
    let target = findTable(tables, scenario.targetTableName)
    const matched = target
      ? input.workflows.find((workflow) => matchesScenario(workflow, scenario, documentId, String(source.id), String(target.id)))
      : undefined
    if (matched) {
      writeMarker(deps.storage, marker)
      if (legacyMarker) writeMarker(deps.storage, legacyMarker)
      existing.push(matched)
      continue
    }
    if (readMarker(deps.storage, marker) || (legacyMarker && readMarker(deps.storage, legacyMarker))) {
      continue
    }

    if (!target && scenario.targetTableSeed) {
      target = await deps.createTable(Number(document.id), scenario.targetTableSeed)
      tables.push(target)
      dispatchTableCreated(input.scopedKitablePath, target.id)
    }
    if (!target) continue

    const template = getOnboardingWorkflowTemplate(scenario.templateId)
      || getBuiltinTemplates(input.translate, { tableName: scenario.sourceTableName })
        .find((item) => item.id === scenario.templateId)
    if (!template) continue

    const sourceTableId = String(source.id)
    const targetTableId = String(target.id)
    const sourceTableName = source.title || source.name || scenario.sourceTableName
    const targetTableName = target.title || target.name || scenario.targetTableName
    const sourceSchema = await deps.fetchSchema(documentId, sourceTableId, sourceTableName)
    const targetSchema = targetTableId === sourceTableId
      ? sourceSchema
      : await deps.fetchSchema(documentId, targetTableId, targetTableName)
    const application = createWorkflowFromTemplate(template, {
      documentId,
      tableId: sourceTableId,
      tableName: sourceTableName,
      schema: sourceSchema,
      tables: [{
        documentId,
        tableId: targetTableId,
        tableName: targetTableName,
        schema: targetSchema,
      }],
    })
    const ready = application.input.enabled || application.graphPatch?.enabled === true
    const disabledDraftReady = scenario.allowDisabledDraft
      && isConfiguredEmailAction(application.input.action)
    if (application.unresolvedFieldNames.length > 0 || (!ready && !disabledDraftReady)) continue

    let workflow = await deps.create(application.input)
    if (application.graphPatch) {
      workflow = await deps.patch(workflow.id, application.graphPatch)
    }
    writeMarker(deps.storage, marker)
    if (legacyMarker) writeMarker(deps.storage, legacyMarker)
    created.push(workflow)
  }

  return { created, existing }
}

function matchesScenario(
  workflow: WorkflowDefinition,
  scenario: OnboardingScenario,
  documentId: string,
  sourceTableId: string,
  targetTableId: string,
) {
  const triggerMatches = scenario.id === 'weekday-priority-planning'
    ? workflow.trigger?.type === 'scheduled_time'
      && workflow.trigger.schedule?.cron === '0 9 * * 1-5'
    : String(workflow.trigger?.documentId || '') === documentId
      && String(workflow.trigger?.tableId || '') === sourceTableId
  if (!triggerMatches) return false
  const actionType = scenario.actionType || 'add_record'
  if (workflow.action?.type !== actionType) return false
  if (actionType === 'add_record') return String(workflow.action.addRecord?.targetTableId || '') === targetTableId
  if (actionType === 'lookup_record') return String(workflow.action.lookupRecord?.targetTableId || '') === targetTableId
  return true
}

function findTable<T extends { id?: number | string; title?: string; name?: string }>(
  tables: T[],
  wanted: string,
) {
  const normalized = normalizeName(wanted)
  return tables.find((table) => (
    normalizeName(table.title) === normalized || normalizeName(table.name) === normalized
  ))
}

function normalizeName(value?: string) {
  return String(value || '').trim().toLocaleLowerCase()
}

function normalizePath(value: string) {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

function pathEndsWith(value: string, suffix: string) {
  const normalizedValue = normalizePath(value)
  const normalizedSuffix = normalizePath(suffix)
  return normalizedValue === normalizedSuffix || normalizedValue.endsWith(`/${normalizedSuffix}`)
}

function isConfiguredEmailAction(action: CreateWorkflowInput['action']) {
  if (action.type !== 'send_email') return false
  const subjectReady = action.subject?.parts?.some((part) => (
    part.kind === 'field_ref' || (part.kind === 'text' && part.text.trim().length > 0)
  ))
  return Boolean(action.to.trim() && subjectReady && action.body?.parts?.length)
}

function dispatchTableCreated(vaultPath: string, tableId: number | string | undefined) {
  if (typeof window === 'undefined' || tableId == null) return
  window.dispatchEvent(new CustomEvent('kition:data-document:table:create', {
    detail: { vaultPath, tableId: Number(tableId) },
  }))
}

function browserStorage(): OnboardingWorkflowStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function markerKey(rootPath: string | undefined, documentId: string, scenarioId: string) {
  return `kition.onboarding-workflow.v${MARKER_VERSION}.${hash(`${rootPath || ''}:${documentId}:${scenarioId}`)}`
}

function legacyContentMarkerKey(rootPath: string | undefined, documentId: string) {
  return `kition.onboarding-workflow.v${LEGACY_CONTENT_MARKER_VERSION}.${hash(`${rootPath || ''}:${documentId}`)}`
}

function hash(value: string) {
  let out = 5381
  for (let index = 0; index < value.length; index += 1) {
    out = ((out << 5) + out + value.charCodeAt(index)) | 0
  }
  return (out >>> 0).toString(36)
}

function readMarker(storage: OnboardingWorkflowStorage | null, key: string) {
  try {
    return storage?.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeMarker(storage: OnboardingWorkflowStorage | null, key: string) {
  try {
    storage?.setItem(key, '1')
  } catch {
    // The persisted workflow itself remains the primary idempotency check.
  }
}
