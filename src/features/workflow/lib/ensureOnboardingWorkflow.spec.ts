import { describe, expect, it, vi } from 'vitest'

import type { WorkflowDefinition } from '@/features/workflow/api'
import { ensureOnboardingWorkflow, type EnsureOnboardingWorkflowDeps } from './ensureOnboardingWorkflow'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

function translate(key: string) {
  const values: Record<string, string> = {
    'templates.contentIdeaToQueue.name': 'Add new ideas to the publishing queue',
    'templates.contentIdeaToQueue.description': 'Works locally with no setup',
    'templates.archiveCompletedTasks.name': 'Archive completed tasks',
    'templates.archiveCompletedTasks.description': 'Archive Done tasks',
    'templates.weekdayPriorityPlanning.name': 'Create a weekday planning task',
    'templates.weekdayPriorityPlanning.description': 'Create a task every weekday',
    'templates.readingProgressJournal.name': 'Keep a reading progress journal',
    'templates.readingProgressJournal.description': 'Append reading snapshots',
  }
  return values[key] || key
}

function workflowFromInput(input: any, id: string): WorkflowDefinition {
  return {
    id,
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    trigger: { nodeId: 'trigger_1', ...input.trigger },
    action: { nodeId: 'action_1', ...input.action },
  } as WorkflowDefinition
}

function makeDeps(overrides: Partial<EnsureOnboardingWorkflowDeps> = {}): EnsureOnboardingWorkflowDeps {
  let sequence = 0
  return {
    listDocuments: vi.fn().mockResolvedValue({ items: [] }),
    createTable: vi.fn() as any,
    fetchSchema: vi.fn() as any,
    create: vi.fn(async (input) => workflowFromInput(input, `auto_${++sequence}`)),
    patch: vi.fn(async (_id, patch) => ({
      id: _id,
      name: 'patched',
      description: '',
      enabled: Boolean(patch.enabled),
      trigger: { nodeId: 'trigger_1', type: 'record_updated', documentId: '7', tableId: '12' },
      action: { nodeId: 'action_1', type: 'add_record', to: '', subject: { parts: [] }, body: { parts: [] } },
    } as WorkflowDefinition)),
    storage: memoryStorage(),
    ...overrides,
  }
}

describe('ensureOnboardingWorkflow', () => {
  it('creates the disabled lead email workflow only for the onboarding lead table file', async () => {
    const storage = memoryStorage()
    const deps = makeDeps({
      listDocuments: vi.fn().mockResolvedValue({
        items: [{
          id: 'onboarding-leads',
          path: 'Getting Started/Guides/Lead Automation/Lead Follow-up.kitable',
          tables: [{ id: 1, title: 'Leads', name: 'leads' }],
        }],
      }),
      fetchSchema: vi.fn().mockResolvedValue({
        id: '1',
        name: 'Leads',
        fields: [
          { id: '1', name: 'First Name', type: 'text' },
          { id: '2', name: 'Last Name', type: 'text' },
          { id: '3', name: 'Work Email', type: 'url' },
          { id: '4', name: 'Company Name', type: 'text' },
          { id: '5', name: 'Company Size', type: 'single_select' },
          { id: '6', name: 'Job Title', type: 'text' },
          { id: '7', name: 'Reason for Contact', type: 'text' },
          { id: '8', name: 'Additional Notes', type: 'long_text' },
        ],
      }),
      storage,
    })
    const input = {
      scopedKitablePath: 'Getting Started/Guides/Lead Automation/Lead Follow-up.kitable',
      rootPath: '/vault',
      workflows: [],
      translate,
    }

    const first = await ensureOnboardingWorkflow(input, deps)
    const second = await ensureOnboardingWorkflow(input, deps)

    expect(first.created).toHaveLength(1)
    expect(second.created).toHaveLength(0)
    expect(deps.create).toHaveBeenCalledTimes(1)
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Form Submission Email Notification to Sales',
      enabled: false,
      trigger: expect.objectContaining({
        type: 'record_created',
        documentId: 'onboarding-leads',
        tableId: '1',
      }),
      action: expect.objectContaining({
        type: 'send_email',
        to: 'sales@kition.ai',
      }),
    }))
  })

  it('does not provision the lead email workflow for an unrelated lead table file', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn().mockResolvedValue({
        items: [{
          id: 7,
          path: 'Sales/Lead Follow-up.kitable',
          tables: [{ id: 12, title: 'Leads', name: 'leads' }],
        }],
      }),
    })

    const result = await ensureOnboardingWorkflow({
      scopedKitablePath: 'Sales/Lead Follow-up.kitable',
      rootPath: '/vault',
      workflows: [],
      translate,
    }, deps)

    expect(result.created).toEqual([])
    expect(deps.create).not.toHaveBeenCalled()
  })

  it('creates the fully bound Content Ideas workflow', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn().mockResolvedValue({
        items: [{
          id: 7,
          path: 'Getting Started/Content Pipeline.kitable',
          tables: [
            { id: 12, title: 'Content Ideas', name: 'content_ideas' },
            { id: 13, title: 'Publishing Queue', name: 'publishing_queue' },
          ],
        }],
      }),
      fetchSchema: vi.fn(async (_documentId: string, tableId: string) => ({
        id: tableId,
        name: tableId === '12' ? 'Content Ideas' : 'Publishing Queue',
        fields: tableId === '12'
          ? [
              { id: '201', name: 'Idea', type: 'text' },
              { id: '202', name: 'Channel', type: 'single_select' },
              { id: '203', name: 'Priority', type: 'single_select' },
              { id: '204', name: 'Status', type: 'single_select' },
            ]
          : [
              { id: '301', name: 'Title', type: 'text' },
              { id: '302', name: 'Channel', type: 'single_select' },
              { id: '303', name: 'Priority', type: 'single_select' },
              { id: '304', name: 'Source Status', type: 'single_select' },
              { id: '305', name: 'Automation Note', type: 'long_text' },
            ],
      })),
    })
    const result = await ensureOnboardingWorkflow({
      scopedKitablePath: 'Getting Started/Content Pipeline.kitable',
      rootPath: '/vault',
      workflows: [],
      translate,
    }, deps)

    expect(result.created).toHaveLength(1)
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      trigger: expect.objectContaining({ tableId: '12', requiredFields: ['201', '202', '203', '204'] }),
      action: expect.objectContaining({ addRecord: expect.objectContaining({ targetTableId: '13' }) }),
    }))
  })

  it('adds the missing Completed Tasks table and creates both Tasks workflows', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn().mockResolvedValue({
        items: [{
          id: 7,
          path: 'Getting Started/Projects & Planning/Task Tracker.kitable',
          tables: [{ id: 12, title: 'Tasks', name: 'tasks' }],
        }],
      }),
      createTable: vi.fn().mockResolvedValue({ id: 13, title: 'Completed Tasks', name: 'completed_tasks' }) as any,
      fetchSchema: vi.fn(async (_documentId: string, tableId: string) => ({
        id: tableId,
        name: tableId === '12' ? 'Tasks' : 'Completed Tasks',
        fields: tableId === '12'
          ? [
              { id: '201', name: 'Name', type: 'text' },
              { id: '202', name: 'Status', type: 'single_select' },
              { id: '203', name: 'Due', type: 'date' },
              { id: '204', name: 'Notes', type: 'long_text' },
            ]
          : [
              { id: '301', name: 'Task', type: 'text' },
              { id: '302', name: 'Status', type: 'single_select' },
              { id: '303', name: 'Due', type: 'date' },
              { id: '304', name: 'Notes', type: 'long_text' },
              { id: '305', name: 'Automation Note', type: 'long_text' },
            ],
      })),
    })
    const result = await ensureOnboardingWorkflow({
      scopedKitablePath: 'Getting Started/Projects & Planning/Task Tracker.kitable',
      rootPath: '/vault',
      workflows: [],
      translate,
    }, deps)

    expect(deps.createTable).toHaveBeenCalledWith(7, expect.objectContaining({ title: 'Completed Tasks' }))
    expect(result.created).toHaveLength(2)
    expect(deps.create).toHaveBeenCalledTimes(2)
    expect(deps.patch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      enabled: true,
      nodes: expect.arrayContaining([expect.objectContaining({ kind: 'filter' })]),
    }))
    expect(vi.mocked(deps.create).mock.calls.map(([payload]) => payload.trigger.type)).toEqual([
      'record_updated',
      'scheduled_time',
    ])
  })

  it.each([
    {
      label: 'Expenses update action',
      path: 'Getting Started/Expense Review.kitable',
      sourceName: 'Expenses',
      tables: [{ id: 12, title: 'Expenses', name: 'expenses' }],
      schemas: {
        '12': [
          { id: '201', name: 'Amount', type: 'number' },
          { id: '202', name: 'Status', type: 'single_select' },
          { id: '203', name: 'Review Note', type: 'long_text' },
        ],
      },
      actionType: 'update_record',
    },
    {
      label: 'Orders catalog lookup',
      path: 'Getting Started/Order Fulfillment.kitable',
      sourceName: 'Orders',
      tables: [
        { id: 12, title: 'Orders', name: 'orders' },
        { id: 13, title: 'Product Catalog', name: 'product_catalog' },
      ],
      schemas: {
        '12': [
          { id: '201', name: 'SKU', type: 'text' },
          { id: '202', name: 'Product Name', type: 'text' },
          { id: '203', name: 'Unit Price', type: 'number' },
          { id: '204', name: 'Category', type: 'text' },
        ],
        '13': [
          { id: '301', name: 'SKU', type: 'text' },
          { id: '302', name: 'Product Name', type: 'text' },
          { id: '303', name: 'Unit Price', type: 'number' },
          { id: '304', name: 'Category', type: 'text' },
        ],
      },
      actionType: 'lookup_record',
    },
    {
      label: 'CRM contact deterministic transforms',
      path: 'Getting Started/Sales & Customer/Simple Client CRM.kitable',
      sourceName: 'Contacts',
      tables: [{ id: 12, title: 'Contacts', name: 'contacts' }],
      schemas: {
        '12': [
          { id: '201', name: 'Email', type: 'text' },
          { id: '202', name: 'Phone', type: 'text' },
          { id: '203', name: 'Email Domain', type: 'text' },
          { id: '204', name: 'Normalized Phone', type: 'text' },
        ],
      },
      actionType: 'transform_record',
    },
  ])('provisions the runnable $label onboarding workflow', async ({ path, sourceName, tables, schemas, actionType }) => {
    const deps = makeDeps({
      listDocuments: vi.fn().mockResolvedValue({ items: [{ id: 7, path, tables }] }),
      fetchSchema: vi.fn(async (_documentId: string, tableId: string) => ({
        id: tableId,
        name: tableId === '13' ? 'Product Catalog' : sourceName,
        fields: schemas[tableId as keyof typeof schemas],
      })),
    })
    const result = await ensureOnboardingWorkflow({
      scopedKitablePath: path,
      rootPath: '/vault',
      workflows: [],
      translate,
    }, deps)

    expect(result.created).toHaveLength(1)
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ type: actionType }),
    }))
    const payload = vi.mocked(deps.create).mock.calls[0][0]
    if (actionType === 'update_record') {
      expect(payload.action.updateRecord?.fields.map((field) => field.fieldId)).toEqual(['202', '203'])
      expect(deps.patch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ enabled: true }))
    } else if (actionType === 'lookup_record') {
      expect(payload.action.lookupRecord).toEqual(expect.objectContaining({
        targetTableId: '13',
        matchFieldId: '301',
        writeBack: [
          { sourceFieldId: '303', targetFieldId: '203' },
          { sourceFieldId: '304', targetFieldId: '204' },
          { sourceFieldId: '302', targetFieldId: '202' },
        ],
      }))
    } else {
      expect(payload.action.transformRecord?.operations.map((operation) => operation.operation)).toEqual([
        'domain_from_email',
        'digits_only',
      ])
    }
  })

  it('does not recreate scenarios after their markers were written', async () => {
    const storage = memoryStorage()
    const docs = {
      items: [{
        id: 7,
        path: 'Getting Started/Content Pipeline.kitable',
        tables: [
          { id: 12, title: 'Content Ideas', name: 'content_ideas' },
          { id: 13, title: 'Publishing Queue', name: 'publishing_queue' },
        ],
      }],
    }
    const schema = vi.fn(async (_documentId: string, tableId: string) => ({
      id: tableId,
      name: '',
      fields: tableId === '12'
        ? [
            { id: '201', name: 'Idea', type: 'text' },
            { id: '202', name: 'Channel', type: 'text' },
            { id: '203', name: 'Priority', type: 'text' },
            { id: '204', name: 'Status', type: 'text' },
          ]
        : [
            { id: '301', name: 'Title', type: 'text' },
            { id: '302', name: 'Channel', type: 'text' },
            { id: '303', name: 'Priority', type: 'text' },
            { id: '304', name: 'Source Status', type: 'text' },
            { id: '305', name: 'Automation Note', type: 'text' },
          ],
    }))
    const firstDeps = makeDeps({ listDocuments: vi.fn().mockResolvedValue(docs), fetchSchema: schema, storage })
    await ensureOnboardingWorkflow({
      scopedKitablePath: 'Getting Started/Content Pipeline.kitable', rootPath: '/vault', workflows: [], translate,
    }, firstDeps)

    const secondDeps = makeDeps({ listDocuments: vi.fn().mockResolvedValue(docs), fetchSchema: schema, storage })
    const result = await ensureOnboardingWorkflow({
      scopedKitablePath: 'Getting Started/Content Pipeline.kitable', rootPath: '/vault', workflows: [], translate,
    }, secondDeps)
    expect(result).toEqual({ created: [], existing: [] })
    expect(secondDeps.create).not.toHaveBeenCalled()
  })
})
