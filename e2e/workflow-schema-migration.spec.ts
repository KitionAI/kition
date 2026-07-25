import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

   
                                                     
  
                                                                        
                                       
                                                                  
                                                                     
                                                                      
                                                                      
                                         
  
                                    
                                         
                                                     
                                                            
                                                                         
                             
   

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

interface SeedLegacyOptions {
  /** Override the workflow returned by the GET. Defaults below match the
   *  smallest v0 shape: schemaVer=0, no nodes/edges, no nodeId on
   *  trigger/action — exactly what normaliseGraph has to synthesise from. */
  workflow?: Record<string, unknown>
}

async function seedLegacyWorkflow(page: import('@playwright/test').Page, options: SeedLegacyOptions = {}) {
  const workflow = options.workflow ?? {
    id: 'wf_legacy',
    name: 'Legacy v0 workflow',
    description: '',
    enabled: false,
    schemaVer: 0,
    trigger: {
      // Deliberately no nodeId — normaliseGraph defaults to 'trigger_1'.
      type: 'record_created',
      tableId: 'tbl_leads',
      documentId: 'doc_1',
    },
    action: {
      // Same — no nodeId on the wire.
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: 'Old lead',
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    },
    // No nodes[] or edges[] — that's the v0 invariant.
  }

  await page.route('**/v1/workflows', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [workflow] }) })
    }
    return route.continue()
  })
  await page.route('**/v1/workflows/wf_legacy', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workflow) })
  )
  await page.route('**/v1/workflows/wf_legacy/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  )
  await page.route('**/v1/workflows/wf_legacy/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) })
  )

  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: '', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'conn_a', channel: 'email_smtp', name: 'Default SMTP',
        settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
        status: 'active', lastErrorMessage: '', usedByCount: 1,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] }),
    }),
  )
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_name', name: 'name', title: 'Name', type: 'text' },
    ], total: 1 } }) }),
  )
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'doc_1', title: 'Leads', tables: [{ id: 'tbl_leads', title: 'Leads', name: 'leads' }] }] }),
    }),
  )
}

test('T6.1 v0 workflow renders trigger + action on the canvas with no nodes[] payload', async ({ page }) => {
  await seedLegacyWorkflow(page)
  await page.goto('/workflow/wf_legacy')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Both nodes appear despite the GET response not carrying nodes/edges.
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toBeVisible()
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toBeVisible()
})

test('T6.2 the synthesised trigger card opens the trigger drawer when clicked', async ({ page }) => {
  await seedLegacyWorkflow(page)
  await page.goto('/workflow/wf_legacy')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  await expect(page.getByTestId('workflow-home-trigger-table')).toBeVisible()
})

test('T6.3 the synthesised action card opens the inline send_email form', async ({ page }) => {
  await seedLegacyWorkflow(page)
  await page.goto('/workflow/wf_legacy')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
  // The drawer's inline send_email form mounts workflow-home-to /
  // workflow-home-subject — synthesising nodeId from defaults shouldn't
  // break the action's drawer wiring.
  await expect(page.getByTestId('workflow-home-to')).toBeVisible()
  await expect(page.getByTestId('workflow-home-to')).toHaveValue('team@example.com')
  // Subject migrated from native input → TemplateTokenInput (chips + raw
  // text), so the editable host is `{testId}-editor` and toHaveValue no
  // longer applies. Assert the rendered text instead.
  await expect(page.getByTestId('workflow-home-subject-editor')).toContainText('Old lead')
})

test('T6.4 explicit schemaVer=0 with empty nodes[]/edges[] still renders cleanly', async ({ page }) => {
  // A subtly different legacy shape: nodes/edges are present but empty.
  // normaliseGraph treats this the same as missing — it falls back to the
  // derived trigger+action wiring.
  await seedLegacyWorkflow(page, {
    workflow: {
      id: 'wf_legacy',
      name: 'Legacy empty-arrays variant',
      description: '',
      enabled: false,
      schemaVer: 0,
      trigger: { type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
      action: { type: 'send_email', to: 'x@example.com', subject: 's', body: { parts: [] } },
      nodes: [],
      edges: [],
    },
  })
  await page.goto('/workflow/wf_legacy')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toBeVisible()
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toBeVisible()
})
