import { expect, test, type Page, type Route } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  installDesignAgentFixture,
  readDesign,
} from './helpers/design'

function headlinePatch(layerId: string, text: string) {
  return {
    type: 'design.patch',
    schema_version: 1,
    summary: `Rewrite the headline to "${text}".`,
    operations: [
      { op: 'text.set', layer_id: layerId, text },
      { op: 'artboard.background', background: '#f4f1ff' },
    ],
  }
}

async function fulfillDesignStream(route: Route, sessionId: number, patch: unknown) {
  const now = '2026-09-29T00:00:00.000Z'
  const events = [
    {
      type: 'user_message',
      chat_message: {
        id: 9101,
        session_id: sessionId,
        user_id: 1,
        role: 'user',
        content: 'Rewrite the headline',
        status: 'completed',
        created_at: now,
      },
    },
    {
      type: 'design_patch_provisional',
      provisional: true,
      design_path: 'Untitled design.kidesign',
      design_patch: patch,
    },
    {
      type: 'design_patch',
      provisional: false,
      design_path: 'Untitled design.kidesign',
      design_patch: patch,
    },
    {
      type: 'done',
      done: true,
      extra_data: {
        session: {
          id: sessionId,
          user_id: 1,
          title: 'Design changes',
          workspace_root: 'browser-local-workspace',
          active_document_path: 'Untitled design.kidesign',
          created_at: now,
          updated_at: now,
        },
      },
    },
  ]
  await route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  })
}

test('previews an agent design patch, applies it on accept, and reverts on reject', async ({
  page,
}) => {
  const requests: Array<Record<string, any>> = []
  await installDesignAgentFixture(page, ['agent_design_v1'])
  await createDesign(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await expectDesignSaved(page)
  const [headline] = designLayers(await readDesign(page))

  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    const request = route.request().postDataJSON() as Record<string, any>
    requests.push(request)
    const sessionId = Number(
      new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 701,
    )
    await fulfillDesignStream(route, sessionId, headlinePatch(headline.id, 'Launch night'))
  })

  await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
  const newChat = page.getByRole('button', { name: 'New chat' })
  if (await newChat.isVisible().catch(() => false)) await newChat.click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await composer.fill('Rewrite the headline for a launch party.')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByTestId('design-agent-preview-controls')).toBeVisible()
  await expect(page.getByTestId('design-agent-operation-list')).toContainText('Set text')
  await expect(page.getByTestId('design-agent-operation-list')).toContainText('Change background')
  await expect(page.locator('.design-artwork text').first()).toContainText('Launch')
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    pane_context: 'design',
    design_context: {
      type: 'design.context',
      schema_version: 1,
      design: { path: 'Untitled design.kidesign' },
      artboard: { width: 1080, height: 1440 },
    },
  })
  expect(Object.keys(requests[0].design_context).sort()).toEqual([
    'artboard', 'design', 'layers', 'recent_operations', 'schema_version', 'selected_layer_ids', 'type',
  ])

  await page.getByTestId('design-agent-reject').click()
  await expect(page.getByTestId('design-agent-preview-controls')).toHaveCount(0)
  expect(designLayers(await readDesign(page))[0].text).toBe(headline.text)

  await composer.fill('Apply that headline now.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('design-agent-accept')).toBeVisible()
  await page.getByTestId('design-agent-accept').click()
  await expectDesignSaved(page)
  let doc = await readDesign(page)
  expect(designLayers(doc)[0].text).toBe('Launch night')
  expect(doc.pages[0].background).toBe('#f4f1ff')

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expectDesignSaved(page)
  doc = await readDesign(page)
  expect(designLayers(doc)[0].text).toBe(headline.text)
  expect(doc.pages[0].background).toBe('#ffffff')
})
