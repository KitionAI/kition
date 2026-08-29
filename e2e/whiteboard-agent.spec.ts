import { expect, test, type Route } from '@playwright/test'

import {
  openWhiteboardFixture,
  readWhiteboardSnapshot,
} from './helpers/whiteboard'

test('streams visible AI board actions and supports reject, accept, and undo', async ({ page }) => {
  const requests: Array<Record<string, any>> = []
  let streamCount = 0

  await openWhiteboardFixture(page, { agentAvailable: true })
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    streamCount += 1
    const request = route.request().postDataJSON() as Record<string, any>
    requests.push(request)
    const sessionId = Number(
      new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 701,
    )
    await fulfillWhiteboardStream(route, sessionId, createMindMapPatch())
  })

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

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    pane_context: 'whiteboard',
    whiteboard_context: {
      scope: 'selection',
      selected_element_ids: ['node-a'],
      current_page: { id: 'page:main' },
      current_tool: 'select',
    },
  })
  expect(requests[0].whiteboard_context.viewport_snapshot.data_url)
    .toContain('data:image/svg+xml')
  expect(Array.isArray(requests[0].whiteboard_context.lint_findings)).toBe(true)

  await page.getByTestId('whiteboard-agent-reject').click()
  await expect.poll(async () => hasElement(page, 'ai-node-1')).toBe(false)

  await composer.fill('Apply the same connected expansion now.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => streamCount).toBe(2)
  await expect(page.getByTestId('whiteboard-agent-accept')).toBeVisible()
  await page.getByTestId('whiteboard-agent-accept').click()

  await expect.poll(async () => hasElement(page, 'ai-node-1')).toBe(true)
  await expect.poll(async () => hasElement(page, 'ai-node-2')).toBe(true)
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).records.some((record) => (
    record.record_type === 'binding'
      && record.from_id === 'ai-connector-1'
      && record.to_id === 'ai-node-1'
  ))).toBe(true)

  await page.getByTestId('whiteboard-undo').click()
  await expect.poll(async () => hasElement(page, 'ai-node-1')).toBe(false)
  await expect.poll(async () => hasElement(page, 'ai-node-2')).toBe(false)
})

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

async function fulfillWhiteboardStream(
  route: Route,
  sessionId: number,
  patch: ReturnType<typeof createMindMapPatch>,
) {
  const now = '2026-08-27T00:00:00.000Z'
  const events = [
    {
      type: 'user_message',
      chat_message: {
        id: 8801,
        session_id: sessionId,
        user_id: 1,
        role: 'user',
        content: 'Expand the board',
        status: 'completed',
        created_at: now,
      },
    },
    {
      type: 'whiteboard_patch_provisional',
      provisional: true,
      board_path: 'Whiteboard E2E.kiboard',
      whiteboard_patch: patch,
    },
    {
      type: 'whiteboard_patch',
      provisional: false,
      board_path: 'Whiteboard E2E.kiboard',
      whiteboard_patch: patch,
    },
    {
      type: 'done',
      done: true,
      extra_data: {
        session: {
          id: sessionId,
          user_id: 1,
          title: 'Whiteboard changes',
          workspace_root: 'browser-local-workspace',
          active_document_path: 'Whiteboard E2E.kiboard',
          status: 'completed',
          created_at: now,
          updated_at: now,
        },
        message: {
          id: 8802,
          session_id: sessionId,
          user_id: 1,
          role: 'assistant',
          content: 'Prepared a connected whiteboard expansion for review.',
          status: 'completed',
          created_at: now,
        },
      },
    },
  ]
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
}

async function hasElement(page: Parameters<typeof readWhiteboardSnapshot>[0], id: string) {
  return (await readWhiteboardSnapshot(page)).records.some((record) => (
    record.record_type === 'element' && record.id === id
  ))
}
