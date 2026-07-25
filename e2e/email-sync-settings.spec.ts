import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

type MockWorkflow = {
  id: string
  name: string
  connection: Record<string, unknown>
  target: Record<string, unknown>
  schedule: Record<string, unknown>
  include_attachments: boolean
  status: string
  last_sync_at?: string
  synced_messages: number
  created_at: string
  updated_at: string
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('stores provider credentials while inbox sync progress stays in Workflow', async ({ page }) => {
  const workflows: MockWorkflow[] = []
  let activeRun: Record<string, unknown> | null = null

  await mockLocalWorkspaceApi(page)
  await mockSuppressLauncher(page, '/tmp/kition-email-sync-vault', ['email_sync'])
  await page.route('**/api/v1/email-sync/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()

    if (method === 'GET' && path === '/api/v1/email-sync/workflows') {
      return fulfill(route, { items: workflows })
    }

    if (method === 'POST' && path === '/api/v1/email-sync/workflows') {
      const payload = request.postDataJSON() as Record<string, any>
      expect(payload.connection).toMatchObject({
        host: 'imap.163.com',
        port: 993,
        tls_mode: 'tls',
      })
      const workflow: MockWorkflow = {
        id: 'mail_1',
        name: String(payload.name),
        connection: payload.connection,
        target: payload.target,
        schedule: payload.schedule,
        include_attachments: Boolean(payload.include_attachments),
        status: payload.schedule.enabled ? 'active' : 'paused',
        synced_messages: 0,
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:00:00Z',
      }
      workflows.push(workflow)
      return fulfill(route, workflow)
    }

    if (method === 'GET' && path === '/api/v1/email-sync/runs') {
      return fulfill(route, { items: activeRun ? [activeRun] : [] })
    }

    if (method === 'POST' && path === '/api/v1/email-sync/workflows/mail_1/runs') {
      expect(request.postDataJSON()).toEqual({ mode: 'full' })
      workflows[0].status = 'syncing'
      activeRun = {
        id: 'mailrun_1',
        workflow_id: 'mail_1',
        mode: 'full',
        status: 'running',
        discovered_messages: 247,
        processed_messages: 120,
        imported: 116,
        updated: 2,
        skipped: 2,
        failed: 0,
        current_batch: 2,
        table_path: 'Mail/Emails.kitable',
        started_at: '2026-07-22T00:00:00Z',
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:01:00Z',
      }
      return fulfill(route, activeRun)
    }

    return route.fulfill({ status: 404, body: '{}' })
  })

  await page.goto('/settings?section=connections')

  await expect(page.getByTestId('email-sync-settings-panel')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Inbox sync workflow' })).toHaveCount(0)
  await page.getByLabel('Search email providers').fill('163')
  await expect(page.getByTestId('email-provider-row-163')).toBeVisible()
  await expect(page.getByTestId('email-provider-row-gmail')).toHaveCount(0)
  await page.getByRole('switch', { name: 'Connect 163 Mail' }).click()
  await expect(page.getByRole('heading', { name: '163 Mail' })).toBeVisible()
  await page.getByTestId('email-provider-account-username').fill('person@163.com')
  await page.getByTestId('email-provider-account-password').fill('app-password')
  await page.getByRole('button', { name: 'Save account' }).click()
  await expect(page.getByTestId('email-providers-pane')).toContainText('Account saved.')
  await expect(page.getByTestId('connections-settings-panel')).toBeVisible()

  workflows.push({
    id: 'mail_1',
    name: '163 Mail inbox',
    connection: {
      host: 'imap.163.com',
      port: 993,
      tls_mode: 'tls',
      username: 'person@163.com',
      mailbox: 'INBOX',
    },
    target: {
      table_path: 'Getting Started/Guides/Email Automation/Inbox.kitable',
      content_folder: 'Mail/Messages',
      attachment_folder: 'Mail/Attachments',
    },
    schedule: { enabled: false, interval_minutes: 15 },
    include_attachments: true,
    status: 'syncing',
    synced_messages: 120,
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:01:00Z',
  })
  activeRun = {
    id: 'mailrun_1',
    workflow_id: 'mail_1',
    mode: 'full',
    status: 'running',
    discovered_messages: 247,
    processed_messages: 120,
    imported: 116,
    updated: 2,
    skipped: 2,
    failed: 0,
    current_batch: 2,
    table_path: 'Getting Started/Guides/Email Automation/Inbox.kitable',
    started_at: '2026-07-22T00:00:00Z',
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:01:00Z',
  }

  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByTestId('workspace-sidebar-workflows').click()
  const emailWorkflowRow = page.getByTestId('email-sync-workflow-row')
  await expect(emailWorkflowRow).toContainText('Sync all · 120 / 247 processed')
  await emailWorkflowRow.click()
  await expect(page.getByTestId('email-sync-workflow-page')).toBeVisible()
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Syncing all email')
  await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('120 of 247 processed')
  await page.getByRole('button', { name: 'Run history' }).click()
  await expect(page.getByTestId('email-sync-current-run')).toContainText('Syncing all email')
  await expect(page.getByTestId('email-sync-current-run')).toContainText('120 of 247 processed')
  const actionBox = await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').boundingBox()
  const drawerBox = await page.getByTestId('workflow-properties-drawer').boundingBox()
  expect(actionBox).not.toBeNull()
  expect(drawerBox).not.toBeNull()
  expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(drawerBox!.x)
})
