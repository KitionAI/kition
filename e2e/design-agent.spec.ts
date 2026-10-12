import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockAgentTurn } from './helpers/agentStream'
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

// The chat panel resets its draft while the session loads, so retry the
// fill until the text sticks and Send is enabled.
async function sendPrompt(page: Page, composer: Locator, text: string) {
  const send = page.getByRole('button', { name: 'Send' })
  await expect(async () => {
    await composer.fill(text)
    await expect(send).toBeEnabled({ timeout: 1000 })
  }).toPass()
  await send.click()
}

test('previews an agent design patch, applies it on accept, and reverts on reject', async ({
  page,
}) => {
  await installDesignAgentFixture(page, ['agent_design_v1'])
  await createDesign(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await expectDesignSaved(page)
  const [headline] = designLayers(await readDesign(page))

  const patch = headlinePatch(headline.id, 'Launch night')
  const turns = await mockAgentTurn(page, (turn) => {
    turn.streamToolCall('call_patch', 'design_propose_patch', patch)
    turn.tool('call_patch', 'design_propose_patch', { operation_count: 2 }, { awaiting_user_review: true }, {
      meta: { kind: 'design.patch', patch },
    })
  })
  const requests = turns.requests

  await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
  const newChat = page.getByRole('button', { name: 'New chat' })
  if (await newChat.isVisible().catch(() => false)) await newChat.click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await sendPrompt(page, composer, 'Rewrite the headline for a launch party.')

  await expect(page.getByTestId('design-agent-preview-controls')).toBeVisible()
  await expect(page.getByTestId('design-agent-operation-list')).toContainText('Set text')
  await expect(page.getByTestId('design-agent-operation-list')).toContainText('Change background')
  await expect(page.locator('.design-artwork text').first()).toContainText('Launch')
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].body).toMatchObject({
    pane_context: 'design',
    design_context: {
      type: 'design.context',
      schema_version: 1,
      design: { path: 'Untitled design.kidesign' },
      artboard: { width: 1080, height: 1440 },
    },
  })
  expect(Object.keys(requests[0].body.design_context as object).sort()).toEqual([
    'artboard', 'design', 'layers', 'recent_operations', 'schema_version', 'selected_layer_ids', 'type',
  ])

  await page.getByTestId('design-agent-reject').click()
  await expect(page.getByTestId('design-agent-preview-controls')).toHaveCount(0)
  expect(designLayers(await readDesign(page))[0].text).toBe(headline.text)

  await sendPrompt(page, composer, 'Apply that headline now.')
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
