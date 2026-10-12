import { expect, test } from '@playwright/test'

import { mockAgentTurn } from './helpers/agentStream'
import {
  openWhiteboardFixture,
  readWhiteboardSnapshot,
} from './helpers/whiteboard'

test('generates an image artifact, places it on the Board, and keeps headline text editable', async ({ page }) => {
  await openWhiteboardFixture(page, { agentAvailable: true })
  const turns = await mockAgentTurn(page, (turn, request) => {
    // A hosted image the model made: logged as a call with its delivered file.
    const artifactPath = request.call === 1
      ? 'Agent/images/901/generated-launch.png'
      : 'Agent/images/902/revised-launch.png'
    turn.tool(`ig_${900 + request.call}`, 'image_generation', { hosted: true }, { path: artifactPath, mime: 'image/png' })
    turn.deliver(`ig_${900 + request.call}`, artifactPath)
    turn.reply('Generated one image artifact for review.')
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

  await expect.poll(() => turns.requests.length).toBe(1)
  expect((turns.requests[0].body as Record<string, any>)).toMatchObject({
    pane_context: 'whiteboard',
    whiteboard_context: {
      selected_element_ids: ['node-a'],
    },
  })
  expect((turns.requests[0].body as Record<string, any>).content).toContain('image_generation tool')
  expect((turns.requests[0].body as Record<string, any>).content).toContain('do not render readable words')

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

  await expect.poll(() => turns.requests.length).toBe(2)
  expect((turns.requests[1].body as Record<string, any>).content).toContain('@{Agent/images/901/generated-launch.png}')
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
