import { expect, test, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

/**
 * T1 — scheduled_time trigger UI (WF-R3 / WF-U1).
 *
 * Covers the new timezone + Next-run preview controls on the
 * ScheduledTriggerPropertiesPanel. The cron picker emits a frequency
 * preset → cron string, the timezone input flows independently into the
 * trigger.schedule.timezone, and the Next-run row asks the new
 * /_preview/schedule endpoint to render upcoming fire times.
 *
 * Routes are inlined because the seedWorkflow helper assumes a
 * record_created trigger and we need scheduled_time here.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

async function seedScheduledWorkflow(page: import('@playwright/test').Page) {
  const workflow = {
    id: 'auto_sched',
    name: 'Daily reminder',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: {
      nodeId: 'trigger_1',
      type: 'scheduled_time',
      tableId: '',
      documentId: '',
      schedule: { cron: '0 9 * * *', timezone: 'UTC' },
    },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: 'Reminder',
      body: { parts: [{ kind: 'text', text: 'Daily reminder' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'scheduled_time', schedule: { cron: '0 9 * * *', timezone: 'UTC' } } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email' } },
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
  await page.route('**/v1/workflows/auto_sched', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      // Apply the trigger patch — the panel sends `{trigger: {schedule: {cron, timezone}}}`
      // so we merge into the existing trigger to preserve nodeId/type.
      const triggerPatch = (body.trigger as Record<string, unknown>) ?? {}
      current = {
        ...current,
        trigger: { ...(current.trigger as Record<string, unknown>), ...triggerPatch,
          schedule: {
            ...((current.trigger as Record<string, unknown>).schedule as Record<string, unknown>),
            ...((triggerPatch.schedule as Record<string, unknown>) ?? {}),
          },
        },
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: current }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
  })
  await page.route('**/v1/workflows/auto_sched/runs**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  )
  await page.route('**/v1/workflows/auto_sched/validate', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) })
  )
  await page.route('**/v1/workflows/_preview/schedule**', (route: Route) => {
    const url = new URL(route.request().url())
    const tz = url.searchParams.get('tz') || 'UTC'
    // Deterministic next-runs — the test asserts on shape, not exact values.
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        nextRuns: ['2026-06-18T09:00:00Z', '2026-06-19T09:00:00Z', '2026-06-20T09:00:00Z'],
        timezone: tz,
      }),
    })
  })
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
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [] }) }),
  )
}

test('T1.1 frequency picker and time-of-day rewrite the cron string preview', async ({ page }) => {
  await seedScheduledWorkflow(page)
  await page.goto('/workflow/auto_sched')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
  // Open the trigger drawer.
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()

  const freq = page.getByTestId('scheduled-trigger-frequency')
  await expect(freq).toBeVisible()
  await expect(freq).toHaveValue('daily')
  // Cron field is read-only in preview mode (locked while frequency !== custom).
  const cron = page.getByTestId('scheduled-trigger-cron')
  await expect(cron).toHaveValue('0 9 * * *')

  // Switch to weekdays — cron preview rewrites in lockstep.
  await freq.selectOption('weekdays')
  await expect(cron).toHaveValue('0 9 * * 1-5')
})

test('T1.2 timezone input renders and accepts a value', async ({ page }) => {
  await seedScheduledWorkflow(page)
  await page.goto('/workflow/auto_sched')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  const tz = page.getByTestId('scheduled-trigger-timezone')
  await expect(tz).toBeVisible()
  await expect(tz).toHaveValue('UTC')
  await tz.fill('Asia/Shanghai')
  await expect(tz).toHaveValue('Asia/Shanghai')
})

test('T1.3 Next-run preview hits the server and renders the result', async ({ page }) => {
  let previewCalls = 0
  await seedScheduledWorkflow(page)
  await page.route('**/v1/workflows/_preview/schedule**', (route: Route) => {
    previewCalls += 1
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        nextRuns: ['2026-06-18T09:00:00Z', '2026-06-19T09:00:00Z', '2026-06-20T09:00:00Z'],
        timezone: 'UTC',
      }),
    })
  })
  await page.goto('/workflow/auto_sched')
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()

  const preview = page.getByTestId('scheduled-trigger-next-run')
  await expect(preview).toBeVisible()
  // The hook is debounced (350ms); wait for the server call to fire and
  // the row to transition out of idle/loading into ready.
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 2000 })
  await expect(preview).toContainText(/Next run:/)
  expect(previewCalls).toBeGreaterThan(0)
})
