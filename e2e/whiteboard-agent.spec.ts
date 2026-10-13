import { expect, test } from '@playwright/test'

import { mockAgentTurn } from './helpers/agentStream'
import {
  openWhiteboardFixture,
  readWhiteboardSnapshot,
} from './helpers/whiteboard'

test('streams visible AI board actions and supports reject, accept, and undo', async ({ page }) => {
  await openWhiteboardFixture(page, { agentAvailable: true })
  const patch = createMindMapPatch()
  const followUp = createFollowUpPatch()
  const turns = await mockAgentTurn(page, (turn, request) => {
    // The provisional preview comes from the streamed arguments, the final
    // patch from the logged result. The third turn edits a node by the id the
    // agent gave it earlier.
    const proposal = request.call === 3 ? followUp : patch
    turn.streamToolCall('call_patch', 'whiteboard_propose_patch', proposal)
    turn.tool('call_patch', 'whiteboard_propose_patch', { operation_count: proposal.operations.length }, { awaiting_user_review: true }, {
      meta: { kind: 'whiteboard.patch', patch: proposal },
    })
    turn.nextStep()
    turn.reply('Prepared a connected whiteboard expansion for review.')
  })
  const streamCount = () => turns.requests.length

  await page.locator('[data-element-id="node-a"]').click()
  await expect(page.getByTestId('whiteboard-ask-ai')).toBeEnabled()
  await page.getByTestId('whiteboard-ask-ai').click()

  const newChat = page.getByRole('button', { name: 'New chat' })
  if (await newChat.isVisible().catch(() => false)) await newChat.click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await expect(composer).toBeVisible()
  await composer.fill('Add two connected ideas to the selected node and arrange them clearly.')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByTestId('whiteboard-agent-preview-controls')).toBeVisible()
  await expect(page.getByTestId('whiteboard-agent-operation-list')).toContainText('Create element')
  await expect(page.getByTestId('whiteboard-agent-operation-list')).toContainText('Create connector')
  await expect(page.getByTestId('whiteboard-agent-preview-layer')).toBeVisible()

  await expect.poll(() => turns.requests.length).toBe(1)
  expect(turns.requests[0].body).toMatchObject({
    pane_context: 'whiteboard',
    whiteboard_context: {
      type: 'whiteboard.context',
      scope: 'selection',
      selected_element_ids: ['node-a'],
    },
  })
  // The wire payload carries only what the public contract documents.
  expect(Object.keys(turns.requests[0].body.whiteboard_context as object).sort()).toEqual([
    'board', 'clusters', 'elements', 'recent_operations', 'renamed_ids', 'schema_version',
    'scope', 'selected_element_ids', 'source_refs', 'type', 'viewport',
  ])
  expect(turns.requests[0].body.whiteboard_context).toMatchObject({ renamed_ids: {} })

  await page.getByTestId('whiteboard-agent-reject').click()
  await expect.poll(async () => elementIdWithText(page, 'Customer insight')).toBeUndefined()

  await composer.fill('Apply the same connected expansion now.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(streamCount).toBe(2)
  await expect(page.getByTestId('whiteboard-agent-accept')).toBeVisible()
  await page.getByTestId('whiteboard-agent-accept').click()

  // The agent's own ids (`ai-node-1`, ...) become new object ids on the board.
  await expect.poll(async () => elementIdWithText(page, 'Customer insight')).toMatch(UUID_V7)
  await expect.poll(async () => elementIdWithText(page, 'Launch experiment')).toMatch(UUID_V7)
  const firstNodeId = await elementIdWithText(page, 'Customer insight')
  const secondNodeId = await elementIdWithText(page, 'Launch experiment')
  const records = (await readWhiteboardSnapshot(page)).records
  const bindings = records.flatMap((record) => (record.record_type === 'binding' ? [record] : []))
  const connectorId = bindings.find((binding) => binding.to_id === firstNodeId)?.from_id
  expect(connectorId).toMatch(UUID_V7)
  expect(bindings.some((binding) => (
    binding.from_id === connectorId && binding.to_id === secondNodeId
  ))).toBe(true)
  expect(JSON.stringify(records)).not.toMatch(/ai-node-|ai-connector-/)

  // A later turn learns the new ids and may still use its own names for them.
  await composer.fill('Rename the first new idea.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(streamCount).toBe(3)
  expect(turns.requests[2].body.whiteboard_context).toMatchObject({
    renamed_ids: {
      'ai-connector-1': connectorId,
      'ai-node-1': firstNodeId,
      'ai-node-2': secondNodeId,
    },
  })
  await expect(page.getByTestId('whiteboard-agent-accept')).toBeVisible()
  await page.getByTestId('whiteboard-agent-accept').click()
  await expect.poll(async () => elementIdWithText(page, 'Customer insight, revised')).toBe(firstNodeId)

  await page.getByTestId('whiteboard-undo').click()
  await expect.poll(async () => elementIdWithText(page, 'Customer insight')).toBe(firstNodeId)
  await page.getByTestId('whiteboard-undo').click()
  await expect.poll(async () => elementIdWithText(page, 'Customer insight')).toBeUndefined()
  await expect.poll(async () => elementIdWithText(page, 'Launch experiment')).toBeUndefined()
})

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function createMindMapPatch() {
  return {
    type: 'whiteboard.patch' as const,
    schema_version: 1 as const,
    summary: 'Add and arrange two connected ideas.',
    operations: [
      {
        op: 'element.create' as const,
        element: {
          id: 'ai-node-1',
          kind: 'mind_node' as const,
          bounds: { x: 360, y: 300, width: 180, height: 96 },
          text: 'Customer insight',
          style: { fill_color: 'purple', stroke_color: 'purple' },
        },
      },
      {
        op: 'element.create' as const,
        element: {
          id: 'ai-node-2',
          kind: 'mind_node' as const,
          bounds: { x: 620, y: 300, width: 180, height: 96 },
          text: 'Launch experiment',
          style: { fill_color: 'green', stroke_color: 'green' },
        },
      },
      {
        op: 'connector.create' as const,
        connector: { id: 'ai-connector-1', from_id: 'ai-node-1', to_id: 'ai-node-2' },
      },
      {
        op: 'layout.stack' as const,
        element_ids: ['ai-node-1', 'ai-node-2'],
        direction: 'horizontal' as const,
        gap: 40,
      },
    ],
  }
}

function createFollowUpPatch() {
  return {
    type: 'whiteboard.patch' as const,
    schema_version: 1 as const,
    summary: 'Rename the first idea.',
    operations: [
      {
        op: 'element.update' as const,
        element_id: 'ai-node-1',
        changes: { text: 'Customer insight, revised' },
      },
    ],
  }
}

async function elementIdWithText(page: Parameters<typeof readWhiteboardSnapshot>[0], text: string) {
  return (await readWhiteboardSnapshot(page)).records.find((record) => (
    record.record_type === 'element' && 'text' in record && record.text === text
  ))?.id
}
