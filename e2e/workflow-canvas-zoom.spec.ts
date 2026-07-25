import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-workflow-canvas-zoom-e2e-vault'

/**
 * Pan / zoom / fit on the WorkflowCanvas (the trigger → action board on the
 * workflow home page).
 *
 * Uses the same shape of fixtures as workflow-canvas.spec.ts so the seed
 * shows exactly one workflow with one trigger + one action. We exercise:
 *   - the bottom-left zoom widget (+ / − / ⛶)
 *   - the readout text (100% on mount)
 *   - drag-from-a-node pans the canvas (transform updates, click suppressed)
 *   - a regular click on a node still selects it (drag-threshold preserved)
 *   - wheel + ⌘/Ctrl zooms toward the cursor
 */

async function mockSuppressLauncher(page: Page) {
  await page.addInitScript(({ vaultPath }) => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const vault = {
      path: vaultPath,
      name: 'Workflow Canvas Zoom E2E Vault',
      added_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    }
    const registry = () => ({ vaults: [vault], active_vault_path: vaultPath })
    const listResponse = () => ({ root_path: vaultPath, items: [] })
    stateWindow.kitionDesktop = {
      shell: 'electron',
      DesktopInfo: async () => ({
        is_desktop: false,
        platform: 'darwin',
        backend_base_url: '',
        data_dir: '',
        cache_dir: '',
        logs_dir: '',
        uploads_dir: '',
        exports_dir: '',
        workspace_dir: vaultPath,
        supports_secure_storage: false,
      }),
      StoreSecureValue: async () => {},
      ReadSecureValue: async (key: string) => {
        if (key === 'kition.desktop.settings.v1') {
          return JSON.stringify({
            models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-4o' } },
            providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: '', apiKey: '', discoveredModels: ['gpt-4o'] } },
          })
        }
        if (key === 'desktop.provider.openai.apiKey.v1') return 'sk-stub'
        return ''
      },
      DeleteSecureValue: async () => {},
      OpenExternalURL: async () => {},
      ListVaults: async () => registry(),
      AddVault: async () => ({ vault, registry: registry() }),
      RemoveVault: async () => registry(),
      RenameVault: async () => ({ vault, registry: registry() }),
      SetActiveVault: async () => ({ list: listResponse(), registry: registry() }),
      ListWorkspaceDocuments: async () => listResponse(),
      ReadWorkspaceDocument: async () => { throw new Error('not used') },
      WriteWorkspaceDocument: async () => { throw new Error('not used') },
    }
  }, { vaultPath: VAULT_PATH })
}

async function seedWorkflow(page: Page) {
  const workflow = {
    id: 'auto_zoom',
    name: 'Pan Zoom Demo',
    description: '',
    enabled: false,
    schemaVer: 2,
    trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'sevennt.leslie@gmail.com',
      subject: 'New Lead',
      body: { parts: [{ kind: 'text', text: 'Hi team' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'sevennt.leslie@gmail.com', subject: 'New Lead' } },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }
  await page.route('**/v1/workflows', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [workflow] }) }),
  )
  await page.route('**/v1/workflows/auto_zoom', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workflow) }),
  )
  await page.route('**/v1/workflows/auto_zoom/runs?limit=1', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }),
  )
  await page.route('**/v1/workflows/auto_zoom/runs?limit=50', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }),
  )
  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: 'd', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'conn_a', channel: 'email_smtp', name: 'Legacy SMTP config',
        settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
        status: 'active', lastErrorMessage: '', usedByCount: 1,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] }),
    }),
  )
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [], total: 0 } }) }),
  )
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'doc_1', title: 'Leads workspace', tables: [{ id: 'tbl_leads', title: 'Leads', name: 'leads' }] }] }),
    }),
  )
}

/** Extract the {tx, ty, scale} currently set on the content layer. */
async function readContentTransform(content: Locator): Promise<{ tx: number; ty: number; scale: number }> {
  return content.evaluate((el) => {
    const t = (el as HTMLElement).style.transform || ''
    const translate = t.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/)
    const scale = t.match(/scale\(([-\d.]+)\)/)
    return {
      tx: translate ? Number(translate[1]) : 0,
      ty: translate ? Number(translate[2]) : 0,
      scale: scale ? Number(scale[1]) : 1,
    }
  })
}

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
  await seedWorkflow(page)
  await page.goto('/workflow/auto_zoom')
  await expect(page.getByTestId('workflow-home-page')).toBeVisible()
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()
})

test('Z1 zoom controls + readout render on the canvas, starting at 100%', async ({ page }) => {
  await expect(page.getByTestId('workflow-canvas-zoom-controls')).toBeVisible()
  await expect(page.getByTestId('workflow-canvas-zoom-in')).toBeVisible()
  await expect(page.getByTestId('workflow-canvas-zoom-out')).toBeVisible()
  await expect(page.getByTestId('workflow-canvas-zoom-fit')).toBeVisible()
  await expect(page.getByTestId('workflow-canvas-zoom-readout')).toHaveText('100%')
})

test('Z2 + button increases zoom, − returns near 100%, readout reflects each step', async ({ page }) => {
  const readout = page.getByTestId('workflow-canvas-zoom-readout')
  await page.getByTestId('workflow-canvas-zoom-in').click()
  await expect(readout).toHaveText('120%')
  await page.getByTestId('workflow-canvas-zoom-in').click()
  await expect(readout).toHaveText('144%')
  await page.getByTestId('workflow-canvas-zoom-out').click()
  await expect(readout).toHaveText('120%')
  await page.getByTestId('workflow-canvas-zoom-out').click()
  // 120% / 1.2 = 100% (within rounding).
  await expect(readout).toHaveText(/^(99|100|101)%$/)
})

test('Z3 zoom is clamped between 25% and 200% no matter how many times the user clicks', async ({ page }) => {
  const readout = page.getByTestId('workflow-canvas-zoom-readout')
  for (let i = 0; i < 25; i += 1) await page.getByTestId('workflow-canvas-zoom-in').click()
  await expect(readout).toHaveText('200%')
  for (let i = 0; i < 25; i += 1) await page.getByTestId('workflow-canvas-zoom-out').click()
  await expect(readout).toHaveText('25%')
})

test('Z4 ⛶ Fit button refits the canvas so the workflow stays inside the viewport', async ({ page }) => {
  const content = page.getByTestId('workflow-canvas-content')
  // Zoom in twice + drag pan, then Fit should normalize back to a value
  // that fits inside the viewport (<= 100%).
  await page.getByTestId('workflow-canvas-zoom-in').click()
  await page.getByTestId('workflow-canvas-zoom-in').click()
  const beforeFit = await readContentTransform(content)
  expect(beforeFit.scale).toBeGreaterThan(1)
  await page.getByTestId('workflow-canvas-zoom-fit').click()
  const afterFit = await readContentTransform(content)
  // Fit clamps to 1.0 max; for our small workflow it should land right at 1.0
  // with a centered tx and a 32px top inset.
  expect(afterFit.scale).toBeLessThanOrEqual(1)
  expect(afterFit.scale).toBeGreaterThanOrEqual(0.25)
  expect(afterFit.ty).toBeCloseTo(32, 0)
})

test('Z5 dragging on a workflow node pans the canvas; the click is swallowed', async ({ page }) => {
  const content = page.getByTestId('workflow-canvas-content')
  const triggerNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await expect(triggerNode).toBeVisible()

  // Action panel is the default selection — switch focus to the trigger node
  // first so we can later assert that the *drag* does not change selection
  // (it should remain on trigger).
  await triggerNode.click()
  await expect(triggerNode).toHaveAttribute('data-selected', 'true')

  const before = await readContentTransform(content)

  // Press on the action node and drag 120px right + 60px down. Because the
  // motion crosses the 4px threshold this counts as a pan, not a click —
  // the action node should NOT become the selected one.
  const box = await actionNode.boundingBox()
  if (!box) throw new Error('action node has no bounding box')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // Multiple small steps so the pointermove handler observes a smooth drag.
  await page.mouse.move(startX + 30, startY + 15, { steps: 5 })
  await page.mouse.move(startX + 60, startY + 30, { steps: 5 })
  await page.mouse.move(startX + 120, startY + 60, { steps: 10 })
  await page.mouse.up()

  // Poll until the transform reflects the drag — React may commit on a later
  // microtask. tx should be roughly before.tx + 120, ty before.ty + 60.
  await expect.poll(async () => (await readContentTransform(content)).tx - before.tx).toBeGreaterThan(100)
  await expect.poll(async () => (await readContentTransform(content)).ty - before.ty).toBeGreaterThan(50)
  // Trigger remains selected — the drag did not also select the action node.
  await expect(triggerNode).toHaveAttribute('data-selected', 'true')
  await expect(actionNode).toHaveAttribute('data-selected', 'false')
})

test('Z6 a regular click on a node (no drag) still selects it', async ({ page }) => {
  const triggerNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await triggerNode.click()
  await expect(triggerNode).toHaveAttribute('data-selected', 'true')
  await actionNode.click()
  await expect(actionNode).toHaveAttribute('data-selected', 'true')
  await expect(triggerNode).toHaveAttribute('data-selected', 'false')
})

test('Z7 ⌘/Ctrl + wheel zooms toward the cursor, plain wheel pans without zooming', async ({ page }) => {
  const content = page.getByTestId('workflow-canvas-content')
  const canvas = page.getByTestId('workflow-canvas')

  const before = await readContentTransform(content)
  const canvasBox = await canvas.boundingBox()
  if (!canvasBox) throw new Error('canvas has no bounding box')
  const cx = canvasBox.x + canvasBox.width / 2
  const cy = canvasBox.y + canvasBox.height / 2

  // Plain wheel — pans (translate changes, scale unchanged).
  //
  // page.mouse.wheel() can be flaky on non-scrollable elements in headless
  // Chromium; dispatching the wheel event directly on the viewport DOM node
  // is the supported workaround and exercises exactly the same code path the
  // production addEventListener('wheel', ...) listener handles.
  await canvas.evaluate(
    (el, { clientX, clientY }) => {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 0,
          deltaY: 120,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      )
    },
    { clientX: cx, clientY: cy },
  )
  await expect.poll(async () => (await readContentTransform(content)).ty).toBeLessThan(before.ty)
  const afterPan = await readContentTransform(content)
  expect(afterPan.scale).toBe(before.scale)

  // ⌘/Ctrl + wheel — zooms (scale changes).
  await canvas.evaluate(
    (el, { clientX, clientY }) => {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 0,
          deltaY: -120,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      )
    },
    { clientX: cx, clientY: cy },
  )
  await expect.poll(async () => (await readContentTransform(content)).scale).toBeGreaterThan(afterPan.scale)
})

test('Z8 the zoom buttons themselves do not initiate a pan when pressed', async ({ page }) => {
  const content = page.getByTestId('workflow-canvas-content')
  const before = await readContentTransform(content)
  // Press the + button, then move 30px sideways before releasing. This should
  // still register as a normal button click (zoom in), not a pan, because the
  // press started on a <button> child.
  const inBtn = page.getByTestId('workflow-canvas-zoom-in')
  const box = await inBtn.boundingBox()
  if (!box) throw new Error('zoom-in button has no bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  const after = await readContentTransform(content)
  // tx / ty should not have shifted (no pan), but scale may have ticked up
  // because the trailing click on the button still fired.
  expect(after.tx).toBe(before.tx)
  expect(after.ty).toBe(before.ty)
})
