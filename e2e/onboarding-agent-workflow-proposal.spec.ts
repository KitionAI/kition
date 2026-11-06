import { expect, test, type Page } from '@playwright/test'

import { mockAgentTurn } from './helpers/agentStream'
import { openInKitFrame } from './helpers/embeddedKit'
import { fulfillJson } from './helpers/mockApi'
import { configureModel, onboardingTable, recordCount, serveKitTables } from './helpers/tableAi'

const TABLE = 'Getting Started/Receipt OCR Table.ktable'

/**
 * AI-SCENE-002 (docs/kition-onboarding-core-scenarios.csv): with the onboarding Receipt OCR Table
 * open, the person asks the agent to review it and propose a cleanup workflow without running it.
 * The turn is bound to the open table; the answer proposes trigger, conditions and actions with the
 * table's real field names; nothing creates, edits, enables, tests or runs a workflow, and the table
 * is not written. A provider failure says so and leaves the table and the workflow list as they were.
 * The agent has no workflow tools at all (crates/kition-agent/src/catalog.rs, no_tool_creates_enables_or_runs_a_workflow).
 */
test('AI-SCENE-002: the agent proposes a cleanup workflow for the open receipt table and runs nothing', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const bytes = await onboardingTable('templates/receipt-ocr-table.ktable')
  await configureModel(page)

  const workflowCalls: Array<{ method: string; url: string }> = []
  let turns: Awaited<ReturnType<typeof mockAgentTurn>> | undefined
  const routes = async (page: Page) => {
    await serveKitTables(page)
    await page.route('**/api/v1/workflows**', async (route) => {
      workflowCalls.push({ method: route.request().method(), url: route.request().url() })
      await fulfillJson(route, { code: 200, message: 'success', data: { items: [] } })
    })
    turns = await mockAgentTurn(page, (turn, request) => {
      if (request.call === 1) {
        turn.reply([
          'Findings: 2 receipts have no Vendor Name and 1 has no Category.',
          'Proposed workflow (not created):',
          '- Trigger: a record is created or updated in Receipts.',
          '- Conditions: Vendor Name is empty or Category is empty.',
          '- Actions: write the missing field names into Plain Text so the receipt can be reviewed.',
        ].join('\n'))
        return
      }
      turn.end('failed', 'The model provider is unavailable.')
    })
  }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, TABLE, bytes, {}, { routes })
  try {
    await expect(recordCount(kit)).toContainText('records', { timeout: 60_000 })
    const workflowCallsBefore = workflowCalls.length

    await kit.getByRole('button', { name: 'Ask Agent' }).click()
    const composer = page.locator('.agent-ai-composer textarea')
    await expect(composer).toBeVisible()
    await composer.fill('Review the active table, identify missing values, and propose a cleanup workflow without running it')
    await page.locator('.agent-ai-send').click()

    const assistant = page.locator('.agent-message.is-assistant')
    await expect(assistant.first()).toContainText('Proposed workflow (not created)')
    expect(turns!.requests[0].body).toMatchObject({ active_document_path: TABLE })

    // The proposal stays a proposal: no workflow request leaves the page and the table is not written.
    expect(workflowCalls.slice(workflowCallsBefore).filter((call) => call.method !== 'GET')).toEqual([])
    expect(saves).toEqual([])
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0)

    // A provider failure says so and changes nothing.
    await composer.fill('Now try again')
    await page.locator('.agent-ai-send').click()
    await expect(page.getByText('The model provider is unavailable.')).toBeVisible({ timeout: 30_000 })
    expect(workflowCalls.slice(workflowCallsBefore).filter((call) => call.method !== 'GET')).toEqual([])
    expect(saves).toEqual([])
  } finally {
    await host.dispose()
  }
})
