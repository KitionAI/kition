import { expect, test, type Route } from '@playwright/test'

import {
  openWhiteboardFixture,
  readWhiteboardSnapshot,
} from './helpers/whiteboard'

test('generates an image artifact, places it on the Board, and keeps headline text editable', async ({ page }) => {
  const requests: Array<Record<string, any>> = []

  await openWhiteboardFixture(page, { agentAvailable: true })
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, any>)
    await fulfillGeneratedImageStream(route, requests.length)
  })

  await page.locator('[data-element-id="node-a"]').click()
  await page.getByTestId('whiteboard-selection-generate-image').click()

  await expect(page.getByTestId('whiteboard-image-studio')).toBeVisible()
  await expect(page.getByTestId('whiteboard-image-template-gallery')).toBeVisible()
  await expect(page.getByTestId('whiteboard-image-template-surreal-city-poster').locator('img')).toBeVisible()
  await expect(page.getByTestId('whiteboard-image-template-mixed-media-memory-card')).toHaveCount(0)
  await page.getByTestId('whiteboard-image-template-view-all').click()
  await expect(page.getByTestId('whiteboard-image-template-mixed-media-memory-card'))
    .toContainText('Select an image on the Board')
  await page.getByTestId('whiteboard-image-template-view-recommended').click()
  await page.getByTestId('whiteboard-image-template-surreal-city-poster').click()
  await expect(page.getByTestId('whiteboard-image-variable-subject')).toHaveValue('Alpha')
  await page.getByTestId('whiteboard-image-variable-subject').fill('A calm launch city for a focused writing product')
  await page.getByTestId('whiteboard-image-exact-text').fill('LAUNCH WITH CLARITY')
  await page.getByTestId('whiteboard-image-generate').click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    pane_context: 'whiteboard',
    whiteboard_context: {
      selected_element_ids: ['node-a'],
    },
  })
  expect(requests[0].content).toContain('image_generation tool')
  expect(requests[0].content).toContain('do not render readable words')

  await expect(page.getByTestId('whiteboard-image-add-0')).toBeVisible()
  await page.getByTestId('whiteboard-image-add-0').click()
  await expect(page.getByTestId('whiteboard-image-add-0')).toBeDisabled()
  await expect(page.getByTestId('whiteboard-image-add-0')).toContainText('Added')
  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    return snapshot.records.some((record) => (
      record.record_type === 'element'
        && record.kind === 'image'
        && record.workspacePath === 'Agent/images/901/generated-launch.png'
    ))
  }).toBe(true)
  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    return snapshot.records.some((record) => (
      record.record_type === 'element'
        && record.kind === 'text'
        && record.text === 'LAUNCH WITH CLARITY'
    ))
  }).toBe(true)

  await page.getByTestId('whiteboard-image-studio-close').click()
  await page.getByTestId('whiteboard-selection-move-area').dblclick()
  await expect(page.getByTestId('whiteboard-text-editor')).toBeVisible()
  await page.getByTestId('whiteboard-text-editor').fill('LAUNCH BETTER')
  await page.getByTestId('whiteboard-text-editor').press('Enter')

  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    return snapshot.records.some((record) => (
      record.record_type === 'element'
        && record.kind === 'text'
      && record.text === 'LAUNCH BETTER'
    ))
  }).toBe(true)

  const editedSnapshot = await readWhiteboardSnapshot(page)
  const generatedImage = editedSnapshot.records.find((record) => (
    record.record_type === 'element'
      && record.kind === 'image'
      && record.workspacePath === 'Agent/images/901/generated-launch.png'
  ))
  const editableHeadline = editedSnapshot.records.find((record) => (
    record.record_type === 'element'
      && record.kind === 'text'
      && record.text === 'LAUNCH BETTER'
  ))
  if (!generatedImage || !editableHeadline) {
    throw new Error('Generated image and editable headline were not available for replacement')
  }

  await page.locator(`[data-element-id="${generatedImage.id}"]`).click({ force: true })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).selectedElementIds)
    .toEqual([generatedImage.id])
  await expect(page.getByTestId('whiteboard-selection-edit-text')).toBeVisible()
  await page.getByTestId('whiteboard-selection-generate-image').click()
  await expect(page.getByTestId('whiteboard-image-template-mixed-media-memory-card')).toBeVisible()
  await page.getByTestId('whiteboard-image-template-mixed-media-memory-card').click()
  await page.getByTestId('whiteboard-image-variable-details').fill('Use a warmer paper tone and emphasize the main subject.')
  await page.getByTestId('whiteboard-image-exact-text').fill('LAUNCH REVISED')
  await page.getByTestId('whiteboard-image-generate').click()

  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1].content).toContain('@{Agent/images/901/generated-launch.png}')
  await expect(page.getByTestId('whiteboard-image-replace-0')).toBeEnabled()
  await page.getByTestId('whiteboard-image-replace-0').click()
  await expect(page.getByTestId('whiteboard-image-replace-0')).toContainText('Replaced')

  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    const imageRecords = snapshot.records.filter((record) => (
      record.record_type === 'element' && record.kind === 'image'
    ))
    return imageRecords.length === 1
      && imageRecords[0].id === generatedImage.id
      && imageRecords[0].workspacePath === 'Agent/images/902/revised-launch.png'
  }).toBe(true)
  await expect.poll(async () => {
    const snapshot = await readWhiteboardSnapshot(page)
    const headlineRecords = snapshot.records.filter((record) => (
      record.record_type === 'element'
        && record.kind === 'text'
        && record.sourceRefIds?.includes(generatedImage.id)
    ))
    return headlineRecords.length === 1
      && headlineRecords[0].id === editableHeadline.id
      && headlineRecords[0].text === 'LAUNCH REVISED'
  }).toBe(true)
})

async function fulfillGeneratedImageStream(route: Route, requestNumber: number) {
  const sessionId = Number(
    new URL(route.request().url()).pathname.match(/sessions\/(\d+)\/messages/)?.[1] || 701,
  )
  const now = '2026-09-03T00:00:00.000Z'
  const toolCallId = 900 + requestNumber
  const artifactPath = requestNumber === 1
    ? 'Agent/images/901/generated-launch.png'
    : 'Agent/images/902/revised-launch.png'
  const events = [
    {
      type: 'tool_call',
      tool_call: {
        id: toolCallId,
        session_id: sessionId,
        user_id: 1,
        tool_name: 'image_generation',
        input_data: { prompt: 'Generate a launch visual' },
        output_data: {
          path: artifactPath,
          mime_type: 'image/png',
        },
        status: 'completed',
        created_at: now,
        updated_at: now,
      },
    },
    {
      type: 'done',
      done: true,
      extra_data: {
        session: {
          id: sessionId,
          user_id: 1,
          title: 'Whiteboard image generation',
          workspace_root: 'browser-local-workspace',
          active_document_path: 'Whiteboard E2E.kiboard',
          status: 'completed',
          created_at: now,
          updated_at: now,
        },
        message: {
          id: 910 + requestNumber,
          session_id: sessionId,
          user_id: 1,
          role: 'assistant',
          content: 'Generated one image artifact for review.',
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
