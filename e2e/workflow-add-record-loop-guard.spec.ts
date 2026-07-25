import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

/**
 * T2 — add_record same-table loop guard (WF-R2).
 *
 * The frontend panel renders an amber inline warning when the add_record
 * action's target table equals the trigger table; the backend validate
 * endpoint also returns `add_record_target_equals_trigger_table` which
 * the page surfaces as a panel-level error and disables Save. These tests
 * cover both layers as the user would see them.
 *
 * Routes are inlined rather than reusing seedWorkflow because the helper
 * hardcodes a send_email action and we need the add_record shape with a
 * configurable targetTableId.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

interface SeedAddRecordOptions {
  triggerTableId?: string
  targetTableId?: string
  validateIssues?: Array<{ nodeId: string; code: string; message: string; level?: string }>
}

async function seedAddRecordWorkflow(page: import('@playwright/test').Page, options: SeedAddRecordOptions = {}) {
  const triggerTableId = options.triggerTableId ?? 'tbl_leads'
  const targetTableId = options.targetTableId ?? triggerTableId
  const workflow = {
    id: 'auto_add_record',
    name: 'Add record on trigger',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: {
      nodeId: 'trigger_1',
      type: 'record_created',
      tableId: triggerTableId,
      documentId: 'doc_1',
    },
    action: {
      nodeId: 'action_1',
      type: 'add_record',
      connectionId: '',
      to: '',
      subject: '',
      body: { parts: [] },
      addRecord: {
        targetTableId,
        targetDocumentId: 'doc_1',
        fields: [
          { fieldId: 'fld_priority', value: { parts: [{ kind: 'text', text: 'high' }] } },
        ],
      },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: triggerTableId } },
      {
        nodeId: 'action_1', kind: 'action',
        config: {
          nodeId: 'action_1', type: 'add_record',
          addRecord: { targetTableId, fields: [{ fieldId: 'fld_priority', value: { parts: [{ kind: 'text', text: 'high' }] } }] },
        },
      },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }

  let current: Record<string, unknown> = workflow
  await page.route('**/v1/workflows', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [current] }) })
    }
    return route.continue()
  })
  await page.route('**/v1/workflows/auto_add_record', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      current = {
        ...current,
        ...body,
        action: { ...(current.action as Record<string, unknown>), ...(body.action as Record<string, unknown> ?? {}) },
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: current }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
  })
  await page.route('**/v1/workflows/auto_add_record/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  )
  await page.route('**/v1/workflows/auto_add_record/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ issues: options.validateIssues ?? [] }) })
  )
  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: '', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  )
  // The trigger table and the add_record's target table share this schema mock;
  // it returns the same field list either way. That's fine for the loop-warning
  // test — the warning fires on the table-ID match, not the schema content.
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_name', name: 'name', title: 'Name', type: 'text' },
    ], total: 2 } }) }),
  )
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'doc_1', title: 'Leads workspace',
        tables: [
          { id: 'tbl_leads', title: 'Leads', name: 'leads' },
          { id: 'tbl_followups', title: 'Followups', name: 'followups' },
        ],
      }] }),
    }),
  )
}

test('T2.1 same-table add_record renders amber loop warning on the action panel', async ({ page }) => {
  // Trigger and target on the same table — the panel's loop warning fires.
  await seedAddRecordWorkflow(page, { triggerTableId: 'tbl_leads', targetTableId: 'tbl_leads' })
  await page.goto('/workflow/auto_add_record')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Action node is selected by default; the AddRecord panel renders.
  const warning = page.getByTestId('add-record-loop-warning')
  await expect(warning).toBeVisible()
  await expect(warning).toContainText(/writing to the trigger table/i)
})

test('T2.2 different target table does not render the loop warning', async ({ page }) => {
  await seedAddRecordWorkflow(page, { triggerTableId: 'tbl_leads', targetTableId: 'tbl_followups' })
  await page.goto('/workflow/auto_add_record')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await expect(page.getByTestId('add-record-loop-warning')).toHaveCount(0)
})

test('T2.3 server validate returning add_record_target_equals_trigger_table surfaces an error in the drawer', async ({ page }) => {
  await seedAddRecordWorkflow(page, {
    triggerTableId: 'tbl_leads',
    targetTableId: 'tbl_leads',
    validateIssues: [{
      nodeId: 'action_1',
      code: 'add_record_target_equals_trigger_table',
      message: 'Action writes back to the trigger table',
      level: 'error',
    }],
  })
  await page.goto('/workflow/auto_add_record')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // The drawer's DrawerField above the target picker shows the server error.
  // Multiple drawer-field-error nodes may exist; check at least one carries
  // the expected message.
  const errors = page.getByTestId('drawer-field-error')
  await expect(errors.filter({ hasText: 'Action writes back to the trigger table' })).toBeVisible()
})
