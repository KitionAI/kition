import { expect, test, type Page, type Route } from '@playwright/test'
import { openWhiteboardFixture } from './helpers/whiteboard'

const template = {
  id: 'launch', version: '2', title: 'Launch poster', description: 'A calm product poster.', operation: 'generate', category: 'poster',
  thumbnail: { url: 'https://kition.ai/test-launch.webp', width: 240, height: 320 },
  default_aspect_ratio: '3:4', default_quality: 'medium', default_resolution: '1K', default_text_mode: 'no_text',
  requires_reference_image: false, access: 'public',
  variables: [{ key: 'subject', label: 'Subject', required: true, multiline: false }], tags: [],
}

async function openImageChat(page: Page) {
  await page.route('**/workspace-files/Agent/generated-*.png', (route) => route.fulfill({
    contentType: 'image/webp', path: 'src/features/media-generation/assets/image-templates/engineering-infographic.webp',
  }))
  await page.route('https://kition.ai/test-launch.webp', (route) => route.fulfill({
    contentType: 'image/webp', path: 'src/features/media-generation/assets/image-templates/engineering-infographic.webp',
  }))
  await openWhiteboardFixture(page)
  await page.evaluate(async () => {
    const settingsModulePath = '/src/services/desktopSettings.ts'
    const { loadDesktopSettings, saveDesktopSettings } = await import(settingsModulePath)
    const settings = await loadDesktopSettings()
    await saveDesktopSettings({ ...settings, general: { ...settings.general, theme: 'light' } })
    const bridge = (window as any).kitionDesktop
    const previous = bridge.BackendStatus
    bridge.BackendStatus = async () => ({ ...(await previous()), capabilities: ['agent_whiteboard_v1', 'agent_image_generation_v1'] })
  })
  await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
  const newChat = page.getByRole('button', { name: 'New chat' })
  if (await newChat.isVisible().catch(() => false)) await newChat.click()
  await expect(page.getByTestId('agent-image-mode')).toBeVisible()
  await page.getByTestId('agent-image-mode').click()
  await expect(page.getByTestId('agent-image-templates')).toBeVisible()
  await expect(page.getByTestId('agent-image-controls')).toHaveCount(0)
}

test('keeps freeform generation, results, and follow-up edits in one visible chat during a catalog outage', async ({ page }) => {
  const requests: Array<{ sessionId: string; body: any }> = []
  await page.route('https://kition.ai/api/media/image-templates**', (route) => route.fulfill({ status: 503 }))
  await openImageChat(page)
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    const body = route.request().postDataJSON()
    const sessionId = route.request().url().match(/sessions\/(\d+)/)![1]
    requests.push({ sessionId, body })
    await fulfillImageStream(route, body, Number(sessionId), requests.length)
  })
  await expect(page.getByTestId('agent-image-templates')).toContainText('Templates are unavailable')
  await page.getByRole('button', { name: 'Start without a template' }).click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await expect(composer).toBeFocused()
  await composer.fill('Create a calm launch poster')
  await composer.press('Enter')
  await expect(page.getByTestId('agent-image-result')).toContainText('Images ready for review')
  expect(requests[0].body).toMatchObject({
    content: 'Create a calm launch poster',
    image_generation_intent: { operation: 'generate', surface: 'whiteboard', placement_preference: 'review' },
  })
  expect(requests[0].body.hide_user_message).not.toBe(true)
  await page.getByRole('button', { name: 'Edit in chat' }).click()
  await composer.fill('Make the background warmer')
  await composer.press('Enter')
  await expect(page.getByTestId('agent-image-result')).toHaveCount(2)
  await expect(page.getByTestId('agent-image-result').last().getByRole('button', { name: 'Edit in chat' })).toBeInViewport()
  expect(requests[1].sessionId).toBe(requests[0].sessionId)
  expect(requests[1].body.image_generation_intent).toMatchObject({ operation: 'edit', reference_paths: ['Agent/generated-1.png'] })
  expect(requests[1].body.image_generation_intent.request_id).not.toBe(requests[0].body.image_generation_intent.request_id)
  await expect(page.getByTestId('whiteboard-image-studio')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/agent-image-chat.png', fullPage: true })
})

test('searches and pages the server catalog, then submits a pinned template version', async ({ page }) => {
  const queries: URL[] = []
  let detailChecks = 0
  let sent: any
  await page.route('https://kition.ai/api/media/image-templates**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/launch')) {
      detailChecks += 1
      expect(url.searchParams.get('version')).toBe('2')
      return route.fulfill({ json: template })
    }
    queries.push(url)
    const first = !url.searchParams.has('cursor') && !url.searchParams.has('query')
    const searching = url.searchParams.has('query')
    return route.fulfill({ json: {
      catalog_revision: 'r1', ...(first ? { next_cursor: 'page-2' } : {}),
      total_count: searching ? 1 : 541,
      items: searching ? [template] : Array.from({ length: 24 }, (_, index) => ({
        ...template,
        id: index === 0 ? first ? 'cover' : 'launch' : `style-${first ? 0 : 24}-${index}`,
        title: index === 0 ? first ? 'Cover image' : template.title : `Style ${index}`,
        ...(index === 1 ? { requires_reference_image: true, operation: 'edit' } : {}),
      })),
    } })
  })
  await openImageChat(page)
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    sent = route.request().postDataJSON()
    await fulfillImageStream(route, sent, Number(route.request().url().match(/sessions\/(\d+)/)![1]), 1)
  })
  await expect(page.getByTestId('agent-image-template-cover')).toBeVisible()
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–24 of 541')
  await expect(page.getByTestId('agent-image-template-style-0-1')).toContainText('Needs image')
  expect(queries[0].searchParams.get('has_reference_image')).toBe('false')
  await expect(page.getByTestId('agent-image-template-cover').locator('img')).toBeVisible()
  expect(await page.getByTestId('agent-image-templates').locator('img').count()).toBeLessThan(24)
  await page.getByTestId('agent-image-template-style-0-23').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('agent-image-template-style-0-23').locator('img')).toBeVisible()
  await page.getByTestId('agent-image-template-style-0-23').click()
  await page.getByRole('button', { name: 'Image templates', exact: true }).click()
  await expect(page.getByTestId('agent-image-template-style-0-23')).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('agent-image-template-launch')).toBeVisible()
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('25–48 of 541')
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–24 of 541')
  await page.getByRole('textbox', { name: 'Search image templates' }).fill('product poster')
  await expect.poll(() => queries.at(-1)?.searchParams.get('query')).toBe('product poster')
  expect(queries.at(-1)?.searchParams.has('cursor')).toBe(false)
  expect(queries.some((url) => url.searchParams.get('cursor') === 'page-2')).toBe(true)
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–1 of 1')
  await page.getByTestId('agent-image-template-launch').click()
  await expect(page.getByLabel('Subject', { exact: false })).toBeFocused()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(page.getByTestId('agent-image-summary').getByRole('status')).toBeVisible()
  await page.getByTestId('agent-image-summary').click()
  await page.getByLabel('Subject', { exact: false }).fill('Kition')
  await page.getByRole('button', { name: 'Image templates', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search image templates' }).fill('product poster')
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–1 of 1')
  await page.getByRole('button', { name: 'Image settings', exact: true }).click()
  await expect(page.getByLabel('Subject', { exact: false })).toHaveValue('Kition')
  await page.getByRole('button', { name: 'Image templates', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Search image templates' })).toHaveValue('product poster')
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–1 of 1')
  await page.getByRole('button', { name: 'Close image settings', exact: true }).click()
  await expect(page.getByTestId('agent-image-controls')).toHaveCount(0)
  await expect(page.getByTestId('agent-image-summary')).toContainText('Launch poster')
  await expect(page.getByPlaceholder('Plan, write, or ask anything…')).toHaveValue('')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('agent-image-result')).toBeVisible()
  expect(detailChecks).toBe(1)
  expect(sent.content).toBe('Launch poster\nKition')
  expect(sent.image_generation_intent).toMatchObject({ template_id: 'launch', template_version: '2', template_variables: { subject: 'Kition' } })
})

test('edits an image from ordinary chat without an open editor and changes its aspect ratio', async ({ page }) => {
  const requests: Array<{ sessionId: number; body: any }> = []
  await page.route('https://kition.ai/api/media/image-templates**', (route) => route.fulfill({ status: 503 }))
  await openImageChat(page)
  await page.getByRole('button', { name: 'Start without a template' }).click()
  await page.getByRole('button', { name: 'Exit image mode', exact: true }).click()
  await page.locator('.document-tab-list').getByRole('button', { name: 'Close tab', exact: true }).click()
  await expect(page.getByTestId('whiteboard-svg-scene')).toHaveCount(0)
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    const body = route.request().postDataJSON()
    const sessionId = Number(route.request().url().match(/sessions\/(\d+)/)![1])
    requests.push({ sessionId, body })
    await fulfillImageStream(route, body, sessionId, requests.length)
  })
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await composer.fill('Create a city travel poster')
  await composer.press('Enter')
  await expect(page.getByTestId('agent-image-result')).toBeVisible()
  expect(requests[0].body.image_generation_intent).toBeUndefined()

  await page.getByRole('button', { name: 'Edit in chat', exact: true }).click()
  await expect(composer).toBeFocused()
  await expect(page.getByTestId('agent-image-summary')).not.toContainText('Open a document')
  await page.getByTestId('agent-image-summary').click()
  await page.getByRole('combobox', { name: 'Aspect ratio', exact: true }).selectOption('9:16')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await composer.fill('Update this image to a portrait layout')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await composer.press('Enter')
  await expect(page.getByTestId('agent-image-result')).toHaveCount(2)
  expect(requests[1].sessionId).toBe(requests[0].sessionId)
  expect(requests[1].body.image_generation_intent).toMatchObject({
    operation: 'edit', aspect_ratio: '9:16', reference_paths: ['Agent/generated-1.png'],
    surface: 'document', placement_preference: 'review',
    target: {
      type: 'image.target.document', document_path: 'Agent/generated-1.png',
      document_format: 'image', selected_image_path: 'Agent/generated-1.png',
    },
  })

  await page.getByTestId('agent-image-result').last().getByRole('button', { name: 'Edit in chat', exact: true }).click()
  await composer.fill('Keep the portrait layout and use warmer colors')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('agent-image-result')).toHaveCount(3)
  expect(requests[2].sessionId).toBe(requests[0].sessionId)
  expect(requests[2].body.image_generation_intent).toMatchObject({
    operation: 'edit', aspect_ratio: '9:16', reference_paths: ['Agent/generated-2.png'],
    target: { document_path: 'Agent/generated-2.png' }, placement_preference: 'review',
  })
})

test('exits image mode from the composer and sends the preserved draft as normal chat', async ({ page }) => {
  let sent: any
  await page.route('https://kition.ai/api/media/image-templates**', (route) => route.fulfill({
    json: { catalog_revision: 'exit-r1', items: [template] },
  }))
  await openImageChat(page)
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({
      headers: { 'content-type': 'application/x-ndjson' },
      body: JSON.stringify({ type: 'done', done: true, extra_data: {} }) + '\n',
    })
  })
  await page.getByTestId('agent-image-template-launch').click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await composer.fill('Summarize the ideas on this board.')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Exit image mode', exact: true }).click()
  await expect(page.getByTestId('agent-image-mode')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('agent-image-summary')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Image settings' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Exit image mode', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('agent-composer-context')).toContainText('Whiteboard E2E.kiboard')
  await expect(composer).toHaveValue('Summarize the ideas on this board.')
  await expect(composer).toBeFocused()
  await composer.press('Enter')
  await expect.poll(() => sent?.content).toBe('Summarize the ideas on this board.')
  expect(sent.image_generation_intent).toBeUndefined()
})

test('browses the published image catalog with real previews', async ({ page }, testInfo) => {
  test.skip(process.env.KITION_E2E_LIVE_IMAGE_CATALOG !== '1', 'Opt in to the public catalog smoke test')
  test.setTimeout(60_000)
  await openImageChat(page)
  const browser = page.getByTestId('agent-image-templates')
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('1–24 of 541')
  const firstImage = browser.locator('img').first()
  await expect.poll(() => firstImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true)
  await expectImagePanelLeftOfChat(page)
  await page.screenshot({ path: testInfo.outputPath('published-image-catalog.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('agent-image-template-count')).toHaveText('25–48 of 541')
  await expect.poll(() => firstImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('published-image-catalog-page-2.png'), animations: 'disabled' })
  await page.getByRole('textbox', { name: 'Search image templates' }).fill('travel souvenir enamel')
  const referenceTemplate = page.getByTestId('agent-image-template-gpt-image-2-case-543')
  await expect(referenceTemplate).toBeVisible()
  await expect(referenceTemplate).toContainText('Needs image')
  await referenceTemplate.click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(page.getByTestId('agent-image-summary')).toContainText('Attach a reference image')
  await page.getByRole('button', { name: 'Exit image mode', exact: true }).click()
  await expect(page.getByTestId('agent-image-mode')).toHaveAttribute('aria-pressed', 'false')
})

for (const theme of ['light', 'dark'] as const) {
  test(`keeps inline files and image controls accessible in narrow ${theme} chat`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('kition.document.agent-sidebar.width.v1', '340'))
    await page.route('https://kition.ai/api/media/image-templates**', (route) => route.fulfill({
      json: { catalog_revision: 'design-r1', items: [template] },
    }))
    await openImageChat(page)
    await page.getByRole('button', { name: 'Exit image mode', exact: true }).click()
    await page.evaluate(async (theme) => {
      const settingsModulePath = '/src/services/desktopSettings.ts'
      const { loadDesktopSettings, saveDesktopSettings } = await import(settingsModulePath)
      const settings = await loadDesktopSettings()
      await saveDesktopSettings({ ...settings, general: { ...settings.general, theme } })
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-desktop-theme', theme)
    const composer = page.getByPlaceholder('Plan, write, or ask anything…')
    const send = page.getByRole('button', { name: 'Send', exact: true })
    const context = page.getByTestId('agent-composer-context')
    await expect(composer).toBeFocused()
    expect((await page.locator('.agent-ai-composer').boundingBox())!.height).toBeLessThanOrEqual(140)
    await composer.fill('Help me refine this launch concept.')
    await expect(send).toBeEnabled()
    await page.locator('.workspace-agent-sidebar').screenshot({ path: testInfo.outputPath(`composer-${theme}.png`) })
    await page.locator('.agent-ai-composer').screenshot({ path: testInfo.outputPath(`input-${theme}.png`) })

    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['# Launch brief'], 'Long launch strategy and product positioning brief.md', { type: 'text/markdown' }))
      return data
    })
    await composer.dispatchEvent('drop', { dataTransfer: transfer })
    await expect(context.getByRole('listitem')).toHaveCount(2)
    await expect(context).toContainText('Long launch strategy and product positioning brief.md')
    await expect(page.locator('.agent-ai-footer').getByTestId('agent-composer-context')).toHaveCount(0)
    const references = await context.boundingBox()
    expect(references!.y + references!.height).toBeLessThanOrEqual((await composer.boundingBox())!.y)
    await expect(context).toBeInViewport({ ratio: 1 })

    const model = page.getByRole('button', { name: 'Choose AI model', exact: true })
    await model.click()
    await expect(page.getByRole('dialog', { name: 'Choose AI model', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(model).toBeFocused()

    await page.getByTestId('agent-image-mode').click()
    await expect(page.getByRole('dialog', { name: 'Image settings' })).toBeInViewport({ ratio: 1 })
    await expectImagePanelLeftOfChat(page)
    await expect(page.getByTestId('agent-image-template-launch')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Search image templates' })).toBeFocused()
    await expect(page.getByTestId('agent-chat-messages')).toBeVisible()
    await expect(composer).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath(`image-templates-${theme}.png`), animations: 'disabled' })
    await page.getByTestId('agent-image-template-launch').click()
    await page.getByLabel('Subject', { exact: false }).fill('Kition')
    await expect(page.getByAltText('Example result for Launch poster')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`image-settings-${theme}.png`), animations: 'disabled' })
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(composer).toBeFocused()
    await expect(page.getByTestId('agent-image-summary')).toContainText('Launch poster')
    await page.locator('.workspace-agent-sidebar').screenshot({ path: testInfo.outputPath(`selected-template-${theme}.png`) })
    await page.locator('.agent-ai-composer').screenshot({ path: testInfo.outputPath(`input-template-${theme}.png`) })
    const footer = await page.locator('.agent-ai-footer').boundingBox()
    for (const control of [send, model, page.getByTestId('agent-image-mode'), page.getByRole('button', { name: 'Exit image mode', exact: true })]) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(footer!.x)
      expect(box.x + box.width).toBeLessThanOrEqual(footer!.x + footer!.width + 1)
    }
    await page.getByTestId('agent-image-summary').click()
    await composer.click()
    await expect(page.getByRole('dialog', { name: 'Image settings' })).toHaveCount(0)
    await expect(composer).toBeFocused()
    await page.getByTestId('agent-image-mode').click()
    await expect(page.getByRole('dialog', { name: 'Image settings' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Image settings' })).toHaveCount(0)
    await expect(composer).toBeFocused()
    await composer.fill(Array.from({ length: 20 }, (_, index) => `Draft line ${index + 1}`).join('\n'))
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(240)
    await expect(send).toBeInViewport({ ratio: 1 })
    await context.getByRole('button', { name: 'Remove Long launch strategy and product positioning brief.md', exact: true }).click()
    await expect(context.getByRole('listitem')).toHaveCount(1)
    await expect(composer).toBeFocused()
  })
}

test('resizes the gallery into a usable overlay on smaller windows and restores its left position', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('kition.document.agent-sidebar.width.v1', '340'))
  await page.route('https://kition.ai/api/media/image-templates**', (route) => route.fulfill({ json: {
    catalog_revision: 'resize-r1', total_count: 24,
    items: Array.from({ length: 24 }, (_, index) => ({ ...template, id: `resize-${index}` })),
  } }))
  await openImageChat(page)
  const dialog = page.getByRole('dialog', { name: 'Image settings' })
  const search = page.getByRole('textbox', { name: 'Search image templates' })
  await expectImagePanelLeftOfChat(page)
  await expect(page.getByTestId('agent-image-template-resize-7')).toBeInViewport({ ratio: 1 })
  for (const width of [900, 600]) {
    await page.setViewportSize({ width, height: 720 })
    await expect(dialog).toHaveAttribute('data-layout', 'overlay')
    await expect(dialog).toBeInViewport({ ratio: 1 })
    expect((await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(width - 160)
    await expect(search).toBeFocused()
    await expect(page.getByRole('button', { name: 'Close image settings', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'Start without a template', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath(`image-gallery-${width}.png`), animations: 'disabled' })
  }
  await page.getByTestId('agent-image-template-resize-0').click()
  await page.getByLabel('Subject', { exact: false }).fill('Preserved on resize')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByPlaceholder('Plan, write, or ask anything…')).toBeFocused()
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByTestId('agent-image-mode').click()
  await expect(page.getByTestId('agent-image-templates')).toBeVisible()
  await expectImagePanelLeftOfChat(page)
  await page.getByRole('button', { name: 'Image settings', exact: true }).click()
  await expect(page.getByLabel('Subject', { exact: false })).toHaveValue('Preserved on resize')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByPlaceholder('Plan, write, or ask anything…')).toBeFocused()
})

async function expectImagePanelLeftOfChat(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Image settings' })
  await expect(dialog).toHaveAttribute('data-layout', 'left')
  await expect(dialog).toHaveAttribute('data-side', 'left')
  await expect(dialog).toBeInViewport({ ratio: 1 })
  const panel = (await dialog.boundingBox())!
  const chat = (await page.locator('.workspace-agent-sidebar').boundingBox())!
  expect(panel.x + panel.width).toBeLessThanOrEqual(chat.x - 8)
  expect(panel.width).toBeGreaterThanOrEqual(600)
  expect(panel.height).toBeGreaterThanOrEqual(500)
}

async function fulfillImageStream(route: Route, body: any, sessionId: number, turn: number) {
  const createdAt = new Date().toISOString()
  const requestId = body.image_generation_intent?.request_id || `chat-image-${turn}`
  const imageEvent = { type: 'image_generation.event', schema_version: 1, request_id: requestId }
  const artifact = {
    id: 800 + turn, path: `Agent/generated-${turn}.png`, mime_type: 'image/png', title: 'Launch image',
    variant_index: 0, variant_count: 1, created_at: createdAt,
    provenance: { request_id: requestId, model_id: 'test-image-model' },
  }
  const events = [
    { type: 'user_message', chat_message: { id: turn * 10, session_id: sessionId, user_id: 1, role: 'user', content: body.content, status: 'completed', created_at: createdAt } },
    { type: 'image_generation_event', image_generation: { ...imageEvent, event: 'image_generation.progress', status: 'generating', progress: 0.5 } },
    { type: 'image_generation_event', image_generation: { ...imageEvent, event: 'image_generation.artifact', status: 'saving', artifact } },
    { type: 'image_generation_event', image_generation: { ...imageEvent, event: 'image_generation.artifact', status: 'saving', artifact } },
    { type: 'image_generation_event', image_generation: { ...imageEvent, event: 'image_generation.completed', status: 'completed', artifact_count: 1 } },
    { type: 'done', done: true, extra_data: { message: { id: turn * 10 + 1, session_id: sessionId, user_id: 1, role: 'assistant', content: 'Image generated for review.', status: 'completed', created_at: createdAt } } },
  ]
  await route.fulfill({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: events.map((event) => JSON.stringify(event)).join('\n') + '\n' })
}
