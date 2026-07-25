import { expect, test } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'
import { seedWorkflow } from './helpers/seedWorkflow'

/**
 * T7 — drawer cleanup after node deletion.
 *
 * When a filter node is selected, the right-hand drawer renders the
 * FilterPropertiesPanel (testid hooks include `filter-mode-chips`).
 * Deleting that filter via Backspace + confirm should:
 *   - remove the filter node card from the canvas (covered by the
 *     existing A2 test in workflow-improvements-2.spec.ts);
 *   - rebind the selection to the action node, so the drawer transitions
 *     from FilterPropertiesPanel to ActionPropertiesPanel without leaving
 *     stale filter chrome visible.
 *
 * The selection rebind is what T7 specifically guards — A2 only checks
 * the canvas. A regression here would surface as the drawer showing
 * controls for a node that no longer exists.
 */

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

test('deleting a selected filter node moves the drawer back to the action panel', async ({ page }) => {
  await seedWorkflow(page, {
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.priority == "high"', mode: 'all' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ],
  })
  await page.goto('/workflow/auto_seed')
  await expect(page.getByTestId('workflow-canvas')).toBeVisible()

  // Select the filter node — the drawer renders the FilterPropertiesPanel.
  const filterNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="filter"]')
  await filterNode.click()
  await expect(page.getByTestId('filter-mode-chips')).toBeVisible()
  // The send_email action's inline drawer form (workflow-home-to) is not
  // mounted while the filter panel owns the drawer.
  await expect(page.getByTestId('workflow-home-to')).toHaveCount(0)

  // Backspace on the focused canvas opens the delete-filter confirm dialog.
  const canvas = page.getByTestId('workflow-canvas')
  await canvas.click({ position: { x: 10, y: 10 } })
  await canvas.press('Backspace')
  await expect(page.getByTestId('workflow-home-confirm')).toBeVisible()
  await page.getByTestId('workflow-home-confirm-ok').click()

  // After confirm:
  //  - the filter card is gone from the canvas;
  //  - selectedNodeId falls back to action_1, so the inline send_email
  //    drawer form takes over and the FilterPropertiesPanel's chips are no
  //    longer mounted.
  await expect(filterNode).toHaveCount(0)
  await expect(page.getByTestId('filter-mode-chips')).toHaveCount(0)
  await expect(page.getByTestId('workflow-home-to')).toBeVisible()
})

test('selecting the trigger after deleting a filter does not resurrect the filter panel', async ({ page }) => {
  // Regression guard: if the rebind logic ever races the canvas redraw,
  // selecting the trigger could briefly show stale filter chrome. Make
  // sure that path is clean — trigger panel renders, filter panel stays
  // unmounted across the transition.
  await seedWorkflow(page, {
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'filter_1', kind: 'filter', config: { nodeId: 'filter_1', type: 'filter', expression: 'trigger_1.priority == "high"', mode: 'all' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ],
  })
  await page.goto('/workflow/auto_seed')
  const filterNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="filter"]')
  await filterNode.click()
  await expect(page.getByTestId('filter-mode-chips')).toBeVisible()

  // Delete the filter.
  const canvas = page.getByTestId('workflow-canvas')
  await canvas.click({ position: { x: 10, y: 10 } })
  await canvas.press('Backspace')
  await page.getByTestId('workflow-home-confirm-ok').click()
  await expect(filterNode).toHaveCount(0)

  // Now click the trigger — the trigger picker (testid workflow-home-trigger-table)
  // should be visible and the filter panel must stay unmounted.
  const triggerNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
  await triggerNode.click()
  await expect(page.getByTestId('workflow-home-trigger-table')).toBeVisible()
  await expect(page.getByTestId('filter-mode-chips')).toHaveCount(0)
})
