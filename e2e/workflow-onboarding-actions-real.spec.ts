import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const API_BASE = process.env.KITION_E2E_API_BASE_URL || 'http://127.0.0.1:18141/api/v1'

type Json = Record<string, any>
type Scenario = {
  workflowId: string
  documentPath: string
  tableId: string
  recordId: string
  expected: Record<string, unknown>
  /** The scenario's tables, as the runtime made them (the trigger table first). */
  tables: Json[]
}

type EmailScenario = {
  workflowId: string
  documentPath: string
  tableId: string
  fieldIds: string[]
}

/** The runtime's API token, from the file it writes (`KITION_API_TOKEN_FILE`, set by scripts/inspect-workflow-onboarding.sh). */
function tokenHeader(): Record<string, string> {
  const file = process.env.KITION_API_TOKEN_FILE
  return file ? { 'Kition-Token': readFileSync(file, 'utf8').trim() } : {}
}

async function api<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...tokenHeader(), ...(init?.headers || {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return (payload?.data ?? payload) as T
}

function fieldId(table: Json, name: string) {
  const field = (table.fields || []).find((item: Json) => item.name === name)
  if (!field?.id) throw new Error(`Missing field ${name}: ${JSON.stringify(table.fields || [])}`)
  return String(field.id)
}

/** Makes a `.ktable` file at `path` and adds `tables` to it through the Table kit. */
async function createDocument(body: { path: string; tables: Array<{ title: string; fields: Json[] }> }) {
  await api<Json>('/kit-tables/files', { method: 'POST', body: JSON.stringify({ path: body.path }) })
  const tables: Json[] = []
  for (const table of body.tables) {
    tables.push(await api<Json>('/kit-tables/tables', {
      method: 'POST',
      body: JSON.stringify({ path: body.path, title: table.title, fields: table.fields }),
    }))
  }
  return { path: body.path, tables }
}

async function createRecord(path: string, tableId: string, values: Json) {
  return api<Json>('/kit-tables/records', {
    method: 'POST',
    body: JSON.stringify({ path, tableId, values }),
  })
}

async function createWorkflow(body: Json) {
  const response = await api<Json>('/workflows', { method: 'POST', body: JSON.stringify(body) })
  return response.workflow || response
}

async function setupLeadEmail(path = 'Getting Started/Guides/Lead Automation/Lead Follow-up.ktable'): Promise<EmailScenario> {
  const doc = await createDocument({
    path,
    tables: [{
      title: 'Leads',
      fields: [
        { title: 'First Name', name: 'first_name', type: 'text', primary: true, required: true },
        { title: 'Last Name', name: 'last_name', type: 'text' },
        { title: 'Work Email', name: 'work_email', type: 'url' },
        { title: 'Company Name', name: 'company_name', type: 'text' },
        { title: 'Company Size', name: 'company_size', type: 'single_select', options: { choices: ['1-10', '11-50', '51-200'] } },
        { title: 'Job Title', name: 'job_title', type: 'text' },
        { title: 'Reason for Contact', name: 'reason_for_contact', type: 'text' },
        { title: 'Additional Notes', name: 'additional_notes', type: 'long_text' },
      ],
    }],
  })
  const table = doc.tables[0]
  const fieldNames = [
    'first_name',
    'last_name',
    'work_email',
    'company_name',
    'job_title',
    'reason_for_contact',
    'additional_notes',
  ]
  const fieldIds = fieldNames.map((name) => fieldId(table, name))
  await createRecord(doc.path, String(table.id), {
    first_name: 'John',
    last_name: 'Doe',
    work_email: 'john.doe@example.com',
    company_name: 'ABC Corp',
    company_size: '51-200',
    job_title: 'Manager',
    reason_for_contact: 'Upgrade to Enterprise Plan',
    additional_notes: 'Planning to scale the team and standardize its processes.',
  })
  const ref = (index: number) => ({
    kind: 'field_ref',
    fieldRef: { nodeId: 'trigger_1', fieldId: fieldIds[index] },
  })
  const workflow = await createWorkflow({
    name: 'Form Submission Email Notification to Sales',
    description: 'Automatically sends an email to the sales team when a new lead is added to the Leads table.',
    enabled: false,
    trigger: {
      type: 'record_created',
      documentPath: doc.path,
      tableId: String(table.id),
    },
    action: {
      type: 'send_email',
      connectionId: '',
      to: 'sales@kition.ai',
      subject: { parts: [{ kind: 'text', text: 'New Lead Submission Notification' }] },
      body: { parts: [
        { kind: 'text', text: 'A new lead has submitted the form. Here are the details:' },
        { kind: 'newline' }, { kind: 'newline' },
        { kind: 'text', text: 'First Name: ' }, ref(0), { kind: 'newline' },
        { kind: 'text', text: 'Last Name: ' }, ref(1), { kind: 'newline' },
        { kind: 'text', text: 'Work Email: ' }, ref(2), { kind: 'newline' },
        { kind: 'text', text: 'Company Name: ' }, ref(3), { kind: 'newline' },
        { kind: 'text', text: 'Job Title: ' }, ref(4), { kind: 'newline' },
        { kind: 'text', text: 'Reason for Contact: ' }, ref(5), { kind: 'newline' },
        { kind: 'text', text: 'Additional Notes: ' }, ref(6),
      ] },
    },
  })
  return {
    workflowId: String(workflow.id),
    documentPath: doc.path,
    tableId: String(table.id),
    fieldIds,
  }
}

/** `required`: whether the input columns are required columns (the branch tests need rows that leave them empty). */
async function setupExpense(required = true): Promise<Scenario> {
  const doc = await createDocument({
    path: `onboarding-expenses-${Date.now()}.ktable`,
    tables: [{
      title: 'Expenses',
      fields: [
        { title: 'Item', name: 'item', type: 'text', primary: true, required: true },
        { title: 'Amount', name: 'amount', type: 'number', required },
        { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['Draft', 'Needs review'] } },
        { title: 'Review Note', name: 'review_note', type: 'long_text' },
      ],
    }],
  })
  const table = doc.tables[0]
  const record = await createRecord(doc.path, String(table.id), { item: 'Conference tickets', amount: 2400, status: 'Draft' })
  const workflow = await createWorkflow({
    name: 'Flag high-value expenses for review', enabled: false,
    trigger: { type: 'record_created_or_updated', documentPath: doc.path, tableId: String(table.id), requiredFields: [fieldId(table, 'amount')] },
    action: {
      type: 'update_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      updateRecord: { target: 'trigger_record', fields: [
        { fieldId: fieldId(table, 'status'), value: { parts: [{ kind: 'text', text: 'Needs review' }] } },
        { fieldId: fieldId(table, 'review_note'), value: { parts: [{ kind: 'text', text: 'Automatically flagged because the amount is above 1000' }] } },
      ] },
    },
  })
  const filter = { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.Amount > 1000', mode: 'all' } }
  await api(`/workflows/${workflow.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      nodes: [workflow.nodes[0], filter, workflow.nodes[1]],
      edges: [{ from: 'trigger_1', to: 'filter_1' }, { from: 'filter_1', to: 'action_1' }],
    }),
  })
  return {
    workflowId: String(workflow.id), documentPath: doc.path, tableId: String(table.id), recordId: String(record.id),
    expected: { status: 'Needs review', review_note: 'Automatically flagged because the amount is above 1000' },
    tables: doc.tables,
  }
}

async function setupOrders(required = true): Promise<Scenario> {
  const doc = await createDocument({
    path: `onboarding-orders-${Date.now()}.ktable`,
    tables: [
      {
        title: 'Orders',
        fields: [
          { title: 'Order', name: 'order', type: 'text', primary: true, required: true },
          { title: 'SKU', name: 'sku', type: 'text', required },
          { title: 'Product Name', name: 'product_name', type: 'text' },
          { title: 'Unit Price', name: 'unit_price', type: 'number' },
          { title: 'Category', name: 'category', type: 'text' },
        ],
      },
      {
        title: 'Product Catalog',
        fields: [
          { title: 'SKU', name: 'sku', type: 'text', primary: true, required: true },
          { title: 'Product Name', name: 'product_name', type: 'text', required: true },
          { title: 'Unit Price', name: 'unit_price', type: 'number' },
          { title: 'Category', name: 'category', type: 'text' },
        ],
      },
    ],
  })
  const orders = doc.tables[0]
  const catalog = doc.tables[1]
  await createRecord(doc.path, String(catalog.id), { sku: 'KB-101', product_name: 'Kition Keyboard', unit_price: 129, category: 'Hardware' })
  const order = await createRecord(doc.path, String(orders.id), { order: 'Order #1001', sku: 'KB-101' })
  const workflow = await createWorkflow({
    name: 'Fill orders from the product catalog', enabled: false,
    trigger: { type: 'record_created_or_updated', documentPath: doc.path, tableId: String(orders.id), requiredFields: [fieldId(orders, 'sku')] },
    action: {
      type: 'lookup_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      lookupRecord: {
        targetDocumentPath: doc.path, targetTableId: String(catalog.id), matchFieldId: fieldId(catalog, 'sku'),
        matchValue: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(orders, 'sku') } }] },
        writeBack: [
          { sourceFieldId: fieldId(catalog, 'product_name'), targetFieldId: fieldId(orders, 'product_name') },
          { sourceFieldId: fieldId(catalog, 'unit_price'), targetFieldId: fieldId(orders, 'unit_price') },
          { sourceFieldId: fieldId(catalog, 'category'), targetFieldId: fieldId(orders, 'category') },
        ],
      },
    },
  })
  return {
    workflowId: String(workflow.id), documentPath: doc.path, tableId: String(orders.id), recordId: String(order.id),
    expected: { product_name: 'Kition Keyboard', unit_price: 129, category: 'Hardware' },
    tables: doc.tables,
  }
}

async function setupContacts(required = true): Promise<Scenario> {
  const doc = await createDocument({
    path: `onboarding-contacts-${Date.now()}.ktable`,
    tables: [{
      title: 'Contacts',
      fields: [
        { title: 'Name', name: 'name', type: 'text', primary: true, required: true },
        { title: 'Email', name: 'email', type: 'text', required },
        { title: 'Phone', name: 'phone', type: 'text', required },
        { title: 'Email Domain', name: 'email_domain', type: 'text' },
        { title: 'Normalized Phone', name: 'normalized_phone', type: 'text' },
      ],
    }],
  })
  const table = doc.tables[0]
  const record = await createRecord(doc.path, String(table.id), { name: 'Alex', email: 'Alex@Example.COM', phone: '+86 138-0013-8000' })
  const workflow = await createWorkflow({
    name: 'Normalize contact details', enabled: false,
    trigger: { type: 'record_created_or_updated', documentPath: doc.path, tableId: String(table.id), requiredFields: [fieldId(table, 'email'), fieldId(table, 'phone')] },
    action: {
      type: 'transform_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      transformRecord: { operations: [
        { source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(table, 'email') } }] }, operation: 'domain_from_email', targetFieldId: fieldId(table, 'email_domain') },
        { source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(table, 'phone') } }] }, operation: 'digits_only', targetFieldId: fieldId(table, 'normalized_phone') },
      ] },
    },
  })
  return {
    workflowId: String(workflow.id), documentPath: doc.path, tableId: String(table.id), recordId: String(record.id),
    expected: { email_domain: 'example.com', normalized_phone: '8613800138000' },
    tables: doc.tables,
  }
}

async function runFromExistingRow(page: Page, scenario: Scenario) {
  await page.goto(`/workflow/${scenario.workflowId}`)
  await expect(page.getByTestId('workflow-canvas')).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
  const picker = page.getByTestId('workflow-home-sample-row-picker').last()
  await expect(picker).toBeEnabled({ timeout: 15_000 })
  await picker.click()
  await page.locator(`[data-testid="workflow-home-sample-row-option"][data-record-id="${scenario.recordId}"]`).click()
  await expect(page.getByTestId('workflow-record-action-test-status')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => {
    const result = await api<{ items: Json[] }>(`/kit-tables/records?${new URLSearchParams({ path: scenario.documentPath, tableId: scenario.tableId })}`)
    const record = result.items.find((item) => String(item.id) === scenario.recordId)
    return Object.entries(scenario.expected).every(([key, value]) => record?.values?.[key] === value)
  }, { timeout: 20_000 }).toBe(true)
}

test.describe.serial('real onboarding workflow actions', () => {
  let case3: EmailScenario
  let expenses: Scenario
  let orders: Scenario
  let contacts: Scenario

  test.beforeAll(async () => {
    await api('/e2e/reset', { method: 'POST' })
    case3 = await setupLeadEmail()
    expenses = await setupExpense()
    orders = await setupOrders()
    contacts = await setupContacts()
  })

  test('accepts the disabled lead email workflow and renders a side-effect-free dry run', async () => {
    const raw = await api<Json>(`/workflows/${case3.workflowId}`)
    const workflow = raw.workflow || raw
    expect(workflow.enabled).toBe(false)
    expect(workflow.trigger).toEqual(expect.objectContaining({
      type: 'record_created',
      documentPath: case3.documentPath,
      tableId: case3.tableId,
    }))
    expect(workflow.action).toEqual(expect.objectContaining({
      type: 'send_email',
      to: 'sales@kition.ai',
    }))
    // No connection is made for it: an empty connection id is left out of the saved action.
    expect(workflow.action.connectionId ?? '').toBe('')
    expect(workflow.action.body.parts.flatMap((part: Json) => (
      part.kind === 'field_ref' ? [String(part.fieldRef.fieldId)] : []
    ))).toEqual(case3.fieldIds)

    const preview = await api<Json>(`/workflows/${case3.workflowId}/dry-run`, { method: 'POST' })
    expect(preview.ok).toBe(true)
    expect(preview.input).toEqual(expect.objectContaining({
      to: 'sales@kition.ai',
      subject: 'New Lead Submission Notification',
    }))
    expect(String(preview.input.body)).toContain('First Name:')
    expect(String(preview.input.body)).toContain('Additional Notes:')
  })

  test('updates the selected high-value expense row', async ({ page }) => {
    await runFromExistingRow(page, expenses)
  })

  test('looks up the catalog and writes product fields back to the order', async ({ page }) => {
    await runFromExistingRow(page, orders)
  })

  test('normalizes email and phone fields deterministically', async ({ page }) => {
    await runFromExistingRow(page, contacts)
  })
})

/** Every record of a table, as the runtime reads it. */
async function records(path: string, tableId: string) {
  const result = await api<{ items: Json[] }>(`/kit-tables/records?${new URLSearchParams({ path, tableId })}`)
  return result.items
}

async function recordValues(path: string, tableId: string, recordId: string) {
  const record = (await records(path, tableId)).find((item) => String(item.id) === String(recordId))
  if (!record) throw new Error(`record ${recordId} is gone from ${path}`)
  return record.values as Json
}

/** Runs a workflow on one existing record, as the Workflows page's sample row does. */
async function runRecord(workflowId: string, documentPath: string, tableId: string, recordId: string) {
  return api<{ ok: boolean; error?: string; run: Json }>(`/workflows/${workflowId}/run-record`, {
    method: 'POST',
    body: JSON.stringify({ recordId, documentPath, tableId }),
  })
}

type QueueScenario = { workflowId: string; documentPath: string; ideas: Json; queue: Json }

/** Content Pipeline: a complete content idea is copied into the publishing queue (onboarding template content-idea-to-publishing-queue). */
async function setupContentPipeline(targetTableId?: (queue: Json) => string, title?: (ideas: Json) => Json): Promise<QueueScenario> {
  const doc = await createDocument({
    path: `onboarding-content-${Date.now()}-${Math.round(Math.random() * 1e6)}.ktable`,
    tables: [
      {
        title: 'Content Ideas',
        fields: [
          { title: 'Idea', name: 'idea', type: 'text', primary: true, required: true },
          { title: 'Channel', name: 'channel', type: 'single_select', options: { choices: ['Blog', 'Newsletter', 'Social'] } },
          { title: 'Priority', name: 'priority', type: 'single_select', options: { choices: ['High', 'Medium', 'Low'] } },
          { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['Drafting', 'Ready'] } },
        ],
      },
      {
        title: 'Publishing Queue',
        fields: [
          { title: 'Title', name: 'title', type: 'text', primary: true, required: true },
          { title: 'Channel', name: 'channel', type: 'text' },
          { title: 'Priority', name: 'priority', type: 'text' },
          { title: 'Source Status', name: 'source_status', type: 'text' },
          { title: 'Automation Note', name: 'automation_note', type: 'long_text' },
        ],
      },
    ],
  })
  const [ideas, queue] = doc.tables
  const ref = (name: string) => ({ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(ideas, name) } })
  const workflow = await createWorkflow({
    name: 'Add a new content idea to the publishing queue', enabled: false,
    trigger: {
      type: 'record_created', documentPath: doc.path, tableId: String(ideas.id),
      requiredFields: ['idea', 'channel', 'priority', 'status'].map((name) => fieldId(ideas, name)),
    },
    action: {
      type: 'add_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      addRecord: {
        targetDocumentPath: doc.path,
        targetTableId: targetTableId ? targetTableId(queue) : String(queue.id),
        fields: [
          { fieldId: fieldId(queue, 'title'), value: { parts: [title ? title(ideas) : ref('idea')] } },
          { fieldId: fieldId(queue, 'channel'), value: { parts: [ref('channel')] } },
          { fieldId: fieldId(queue, 'priority'), value: { parts: [ref('priority')] } },
          { fieldId: fieldId(queue, 'source_status'), value: { parts: [ref('status')] } },
          { fieldId: fieldId(queue, 'automation_note'), value: { parts: [{ kind: 'text', text: 'Added automatically by workflow' }] } },
        ],
      },
    },
  })
  return { workflowId: String(workflow.id), documentPath: doc.path, ideas, queue }
}

/** The branches the onboarding scenarios list beside their happy paths (docs/kition-onboarding-core-scenarios.csv). */
test.describe('onboarding workflow branches', () => {
  test('WF-SCENE-001: contact cleanup keeps the source fields, adds no record, repeats itself, and skips a row without an email', async () => {
    const contacts = await setupContacts(false)
    const [table] = contacts.tables
    const first = await runRecord(contacts.workflowId, contacts.documentPath, contacts.tableId, contacts.recordId)
    expect(first.ok).toBe(true)
    expect(await recordValues(contacts.documentPath, contacts.tableId, contacts.recordId)).toEqual(expect.objectContaining({
      name: 'Alex', email: 'Alex@Example.COM', phone: '+86 138-0013-8000', ...contacts.expected,
    }))
    const again = await runRecord(contacts.workflowId, contacts.documentPath, contacts.tableId, contacts.recordId)
    expect(again.ok).toBe(true)
    expect(await recordValues(contacts.documentPath, contacts.tableId, contacts.recordId)).toEqual(expect.objectContaining(contacts.expected))
    expect(await records(contacts.documentPath, contacts.tableId)).toHaveLength(1)

    // A contact without an email: the cleanup says it skipped the row and leaves the domain it had.
    const partial = await createRecord(contacts.documentPath, String(table.id), {
      name: 'Sam', email: '', phone: '555 0100', email_domain: 'keep.example', normalized_phone: '5550100',
    })
    const skipped = await runRecord(contacts.workflowId, contacts.documentPath, contacts.tableId, String(partial.id))
    expect(skipped.ok).toBe(false)
    expect(skipped.run.status).toBe('skipped')
    expect(String(skipped.run.skipReason)).toContain('Email')
    expect(await recordValues(contacts.documentPath, contacts.tableId, String(partial.id))).toEqual(expect.objectContaining({
      email_domain: 'keep.example', normalized_phone: '5550100',
    }))
  })

  test('WF-SCENE-002: only an amount above 1000 is flagged; lower and missing amounts stay Draft', async () => {
    const expenses = await setupExpense(false)
    const [table] = expenses.tables
    const lunch = await createRecord(expenses.documentPath, String(table.id), { item: 'Team lunch', amount: 280, status: 'Draft' })
    const cloud = await createRecord(expenses.documentPath, String(table.id), { item: 'Cloud subscription', amount: 899, status: 'Draft' })
    const unknown = await createRecord(expenses.documentPath, String(table.id), { item: 'Taxi', status: 'Draft' })
    for (const id of [String(lunch.id), String(cloud.id)]) {
      const run = await runRecord(expenses.workflowId, expenses.documentPath, expenses.tableId, id)
      expect(run.ok).toBe(false)
      expect(run.run.status).toBe('skipped')
      expect(String(run.run.skipReason)).toContain('filter_1')
      expect(await recordValues(expenses.documentPath, expenses.tableId, id)).toEqual(expect.objectContaining({ status: 'Draft' }))
      expect((await recordValues(expenses.documentPath, expenses.tableId, id)).review_note ?? '').toBe('')
    }
    const missing = await runRecord(expenses.workflowId, expenses.documentPath, expenses.tableId, String(unknown.id))
    expect(missing.ok).toBe(false)
    expect(missing.run.status).toBe('skipped')
    expect(String(missing.run.skipReason)).toContain('Amount')
    expect(await recordValues(expenses.documentPath, expenses.tableId, String(unknown.id))).toEqual(expect.objectContaining({ status: 'Draft' }))

    const flagged = await runRecord(expenses.workflowId, expenses.documentPath, expenses.tableId, expenses.recordId)
    expect(flagged.ok).toBe(true)
    expect(await recordValues(expenses.documentPath, expenses.tableId, expenses.recordId)).toEqual(expect.objectContaining(expenses.expected))
    expect(await records(expenses.documentPath, expenses.tableId)).toHaveLength(4)
  })

  test('WF-SCENE-003: an unknown SKU matches nothing and a blank SKU is skipped; neither copies or erases values', async () => {
    const orders = await setupOrders(false)
    const [ordersTable, catalog] = orders.tables
    const catalogBefore = await records(orders.documentPath, String(catalog.id))
    const unknown = await createRecord(orders.documentPath, String(ordersTable.id), { order: 'Order #1002', sku: 'ZZ-999', product_name: 'Keep me', unit_price: 5 })
    const noMatch = await runRecord(orders.workflowId, orders.documentPath, orders.tableId, String(unknown.id))
    expect(noMatch.ok).toBe(true)
    const action = (noMatch.run.nodeOutcomes as Json[]).find((outcome) => outcome.kind === 'action')
    expect(JSON.parse(String(action?.detail))).toEqual(expect.objectContaining({ matched: false, matchValue: 'ZZ-999' }))
    expect(await recordValues(orders.documentPath, orders.tableId, String(unknown.id))).toEqual(expect.objectContaining({ product_name: 'Keep me', unit_price: 5 }))

    const blank = await createRecord(orders.documentPath, String(ordersTable.id), { order: 'Order #1003', sku: '', product_name: 'Keep too' })
    const skipped = await runRecord(orders.workflowId, orders.documentPath, orders.tableId, String(blank.id))
    expect(skipped.ok).toBe(false)
    expect(skipped.run.status).toBe('skipped')
    expect(String(skipped.run.skipReason)).toContain('SKU')
    expect(await recordValues(orders.documentPath, orders.tableId, String(blank.id))).toEqual(expect.objectContaining({ product_name: 'Keep too' }))
    expect(await records(orders.documentPath, String(catalog.id))).toEqual(catalogBefore)
  })

  test('WF-SCENE-004: one run copies a complete idea into exactly one queue row; incomplete or failed runs add none', async () => {
    const pipeline = await setupContentPipeline()
    const idea = await createRecord(pipeline.documentPath, String(pipeline.ideas.id), { idea: 'Product launch announcement', channel: 'Blog', priority: 'High', status: 'Drafting' })
    const ideaBefore = await recordValues(pipeline.documentPath, String(pipeline.ideas.id), String(idea.id))
    const run = await runRecord(pipeline.workflowId, pipeline.documentPath, String(pipeline.ideas.id), String(idea.id))
    expect(run.ok).toBe(true)
    const queued = await records(pipeline.documentPath, String(pipeline.queue.id))
    expect(queued).toHaveLength(1)
    expect(queued[0].values).toEqual(expect.objectContaining({
      title: 'Product launch announcement', channel: 'Blog', priority: 'High', source_status: 'Drafting',
      automation_note: 'Added automatically by workflow',
    }))
    expect(await recordValues(pipeline.documentPath, String(pipeline.ideas.id), String(idea.id))).toEqual(ideaBefore)
    expect(await records(pipeline.documentPath, String(pipeline.ideas.id))).toHaveLength(1)

    // An idea without a channel is skipped, not queued half-filled.
    const incomplete = await createRecord(pipeline.documentPath, String(pipeline.ideas.id), { idea: 'Half an idea', priority: 'Low', status: 'Drafting' })
    const skipped = await runRecord(pipeline.workflowId, pipeline.documentPath, String(pipeline.ideas.id), String(incomplete.id))
    expect(skipped.ok).toBe(false)
    expect(skipped.run.status).toBe('skipped')
    expect(String(skipped.run.skipReason)).toContain('Channel')
    expect(await records(pipeline.documentPath, String(pipeline.queue.id))).toHaveLength(1)

    // A queue that is not there: the run fails and nothing is written.
    const broken = await setupContentPipeline(() => '999999')
    const brokenIdea = await createRecord(broken.documentPath, String(broken.ideas.id), { idea: 'Lost idea', channel: 'Blog', priority: 'High', status: 'Ready' })
    const failed = await runRecord(broken.workflowId, broken.documentPath, String(broken.ideas.id), String(brokenIdea.id))
    expect(failed.ok).toBe(false)
    expect(failed.run.status).toBe('error')
    expect(await records(broken.documentPath, String(broken.queue.id))).toHaveLength(0)

    // A field the title points at is gone: the run fails rather than writing a placeholder into the queue.
    const dangling = await setupContentPipeline(undefined, () => ({ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: '999999' } }))
    const danglingIdea = await createRecord(dangling.documentPath, String(dangling.ideas.id), { idea: 'Renamed idea', channel: 'Social', priority: 'Medium', status: 'Ready' })
    const refused = await runRecord(dangling.workflowId, dangling.documentPath, String(dangling.ideas.id), String(danglingIdea.id))
    expect(refused.ok).toBe(false)
    expect(String(refused.error)).toContain('999999')
    expect(await records(dangling.documentPath, String(dangling.queue.id))).toHaveLength(0)
  })

  test('WF-SCENE-005: the lead preview shows the seeded lead exactly, names a field that is gone, and changes nothing', async () => {
    const lead = await setupLeadEmail(`onboarding-leads-${Date.now()}.ktable`)
    const [record] = await records(lead.documentPath, lead.tableId)
    const before = await api<Json>(`/workflows/${lead.workflowId}`)
    const preview = await api<Json>(`/workflows/${lead.workflowId}/dry-run`, {
      method: 'POST',
      body: JSON.stringify({ triggerFields: record.values }),
    })
    expect(preview.ok).toBe(true)
    expect(preview.input).toEqual({
      to: 'sales@kition.ai',
      subject: 'New Lead Submission Notification',
      body: [
        'A new lead has submitted the form. Here are the details:',
        '',
        'First Name: John',
        'Last Name: Doe',
        'Work Email: john.doe@example.com',
        'Company Name: ABC Corp',
        'Job Title: Manager',
        'Reason for Contact: Upgrade to Enterprise Plan',
        'Additional Notes: Planning to scale the team and standardize its processes.',
      ].join('\n'),
    })
    expect(preview.unresolved ?? []).toEqual([])

    // A field the body names is gone: the preview says which one instead of filling in another.
    const raw = before.workflow || before
    const body = { parts: [...raw.action.body.parts, { kind: 'newline' }, { kind: 'text', text: 'Budget: ' }, { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: '999999' } }] }
    await api(`/workflows/${lead.workflowId}`, { method: 'PATCH', body: JSON.stringify({ action: { ...raw.action, body } }) })
    const changed = await api<Json>(`/workflows/${lead.workflowId}`)
    const dangling = await api<Json>(`/workflows/${lead.workflowId}/dry-run`, { method: 'POST', body: JSON.stringify({ triggerFields: record.values }) })
    expect(dangling.unresolved).toEqual(['999999'])
    expect(String(dangling.input.body)).not.toContain('John\nBudget')
    expect(await api<Json>(`/workflows/${lead.workflowId}`)).toEqual(changed)
    expect((changed.workflow || changed).enabled).toBe(false)
  })
})
