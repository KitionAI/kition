import { expect, test, type Page } from '@playwright/test'

const API_BASE = process.env.KITION_E2E_API_BASE_URL || 'http://127.0.0.1:18141/api/v1'

type Json = Record<string, any>
type Scenario = {
  workflowId: string
  documentId: string
  tableId: string
  recordId: string
  expected: Record<string, unknown>
}

type EmailScenario = {
  workflowId: string
  documentId: string
  tableId: string
  fieldIds: string[]
}

async function api<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
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

async function createDocument(body: Json) {
  return api<Json>('/data-documents', { method: 'POST', body: JSON.stringify(body) })
}

async function createRecord(documentId: string, tableId: string, values: Json) {
  return api<Json>(`/data-documents/${documentId}/tables/${tableId}/records`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  })
}

async function createWorkflow(body: Json) {
  const response = await api<Json>('/workflows', { method: 'POST', body: JSON.stringify(body) })
  return response.workflow || response
}

async function setupLeadEmail(): Promise<EmailScenario> {
  const doc = await createDocument({
    title: 'Leads',
    path: 'Getting Started/Guides/Lead Automation/Lead Follow-up.kitable',
    tables: [{
      title: 'Leads', name: 'leads',
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
      views: [{ title: 'Leads', type: 'grid' }],
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
  await createRecord(String(doc.id), String(table.id), {
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
      documentId: String(doc.id),
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
    documentId: String(doc.id),
    tableId: String(table.id),
    fieldIds,
  }
}

async function setupExpense(): Promise<Scenario> {
  const doc = await createDocument({
    title: 'Expenses', path: `onboarding-expenses-${Date.now()}.kitable`,
    tables: [{
      title: 'Expenses', name: 'expenses',
      fields: [
        { title: 'Item', name: 'item', type: 'text', primary: true, required: true },
        { title: 'Amount', name: 'amount', type: 'number', required: true },
        { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['Draft', 'Needs review'] } },
        { title: 'Review Note', name: 'review_note', type: 'long_text' },
      ],
      views: [{ title: 'All expenses', type: 'grid' }],
    }],
  })
  const table = doc.tables[0]
  const record = await createRecord(String(doc.id), String(table.id), { item: 'Conference tickets', amount: 2400, status: 'Draft' })
  const workflow = await createWorkflow({
    name: 'Flag high-value expenses for review', enabled: false,
    trigger: { type: 'record_created_or_updated', documentId: String(doc.id), tableId: String(table.id), requiredFields: [fieldId(table, 'amount')] },
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
    workflowId: String(workflow.id), documentId: String(doc.id), tableId: String(table.id), recordId: String(record.id),
    expected: { status: 'Needs review', review_note: 'Automatically flagged because the amount is above 1000' },
  }
}

async function setupOrders(): Promise<Scenario> {
  const doc = await createDocument({
    title: 'Orders', path: `onboarding-orders-${Date.now()}.kitable`,
    tables: [
      {
        title: 'Orders', name: 'orders',
        fields: [
          { title: 'Order', name: 'order', type: 'text', primary: true, required: true },
          { title: 'SKU', name: 'sku', type: 'text', required: true },
          { title: 'Product Name', name: 'product_name', type: 'text' },
          { title: 'Unit Price', name: 'unit_price', type: 'number' },
          { title: 'Category', name: 'category', type: 'text' },
        ], views: [{ title: 'Orders', type: 'grid' }],
      },
      {
        title: 'Product Catalog', name: 'product_catalog',
        fields: [
          { title: 'SKU', name: 'sku', type: 'text', primary: true, required: true },
          { title: 'Product Name', name: 'product_name', type: 'text', required: true },
          { title: 'Unit Price', name: 'unit_price', type: 'number' },
          { title: 'Category', name: 'category', type: 'text' },
        ], views: [{ title: 'Catalog', type: 'grid' }],
      },
    ],
  })
  const orders = doc.tables[0]
  const catalog = doc.tables[1]
  await createRecord(String(doc.id), String(catalog.id), { sku: 'KB-101', product_name: 'Kition Keyboard', unit_price: 129, category: 'Hardware' })
  const order = await createRecord(String(doc.id), String(orders.id), { order: 'Order #1001', sku: 'KB-101' })
  const workflow = await createWorkflow({
    name: 'Fill orders from the product catalog', enabled: false,
    trigger: { type: 'record_created_or_updated', documentId: String(doc.id), tableId: String(orders.id), requiredFields: [fieldId(orders, 'sku')] },
    action: {
      type: 'lookup_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      lookupRecord: {
        targetDocumentId: String(doc.id), targetTableId: String(catalog.id), matchFieldId: fieldId(catalog, 'sku'),
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
    workflowId: String(workflow.id), documentId: String(doc.id), tableId: String(orders.id), recordId: String(order.id),
    expected: { product_name: 'Kition Keyboard', unit_price: 129, category: 'Hardware' },
  }
}

async function setupContacts(): Promise<Scenario> {
  const doc = await createDocument({
    title: 'Contacts', path: `onboarding-contacts-${Date.now()}.kitable`,
    tables: [{
      title: 'Contacts', name: 'contacts',
      fields: [
        { title: 'Name', name: 'name', type: 'text', primary: true, required: true },
        { title: 'Email', name: 'email', type: 'text', required: true },
        { title: 'Phone', name: 'phone', type: 'text', required: true },
        { title: 'Email Domain', name: 'email_domain', type: 'text' },
        { title: 'Normalized Phone', name: 'normalized_phone', type: 'text' },
      ], views: [{ title: 'Contacts', type: 'grid' }],
    }],
  })
  const table = doc.tables[0]
  const record = await createRecord(String(doc.id), String(table.id), { name: 'Alex', email: 'Alex@Example.COM', phone: '+86 138-0013-8000' })
  const workflow = await createWorkflow({
    name: 'Normalize contact details', enabled: false,
    trigger: { type: 'record_created_or_updated', documentId: String(doc.id), tableId: String(table.id), requiredFields: [fieldId(table, 'email'), fieldId(table, 'phone')] },
    action: {
      type: 'transform_record', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] },
      transformRecord: { operations: [
        { source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(table, 'email') } }] }, operation: 'domain_from_email', targetFieldId: fieldId(table, 'email_domain') },
        { source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: fieldId(table, 'phone') } }] }, operation: 'digits_only', targetFieldId: fieldId(table, 'normalized_phone') },
      ] },
    },
  })
  return {
    workflowId: String(workflow.id), documentId: String(doc.id), tableId: String(table.id), recordId: String(record.id),
    expected: { email_domain: 'example.com', normalized_phone: '8613800138000' },
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
    const result = await api<{ items: Json[] }>(`/data-documents/${scenario.documentId}/tables/${scenario.tableId}/records`)
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
      documentId: case3.documentId,
      tableId: case3.tableId,
    }))
    expect(workflow.action).toEqual(expect.objectContaining({
      type: 'send_email',
      connectionId: '',
      to: 'sales@kition.ai',
    }))
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
