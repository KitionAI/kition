import { expect, test } from '@playwright/test'
import { openWhiteboardFixture } from './helpers/whiteboard'

const imagePath = 'Agent/images/46/Edited poster.png'
const imageURL = 'http://127.0.0.1:18101/workspace-files/Agent/images/46/Edited%20poster.png'

for (const source of ['workspace path', 'runtime URL'] as const) {
  test(`opens the generated tool image from a ${source} inside the workspace`, async ({ page }, testInfo) => {
    await page.route('**/workspace-files/Agent/images/46/Edited%20poster.png', (route) => route.fulfill({
      contentType: 'image/png', path: 'public/logo-mark.png',
    }))
    await openWhiteboardFixture(page)
    await page.evaluate((imagePath) => {
      const bridge = window.kitionDesktop!
      const read = bridge.ReadWorkspaceDocument!
      bridge.ReadWorkspaceDocument = async (request) => request.path === imagePath ? {
        path: imagePath, name: 'Edited poster.png', format: 'image', content: '',
        updated_at: '2026-09-09T00:00:00.000Z', size: 100,
      } : read(request)
    }, imagePath)
    await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
    const newChat = page.getByRole('button', { name: 'New chat', exact: true })
    if (await newChat.isVisible().catch(() => false)) await newChat.click()

    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      const sessionId = Number(route.request().url().match(/sessions\/(\d+)/)![1])
      const createdAt = new Date().toISOString()
      const frames = [
        { type: 'user_message', chat_message: {
          id: 10, session_id: sessionId, user_id: 1, role: 'user',
          content: route.request().postDataJSON().content, status: 'completed', created_at: createdAt,
        } },
        { type: 'tool_call', tool_call: {
          id: 20, session_id: sessionId, user_id: 1, message_id: 10,
          tool_name: 'image_generation', status: 'completed', input_data: {},
          output_data: source === 'workspace path' ? { path: imagePath } : { images: [{ url: imageURL }] },
          created_at: createdAt, updated_at: createdAt,
        } },
        { type: 'done', done: true, extra_data: { message: {
          id: 11, session_id: sessionId, user_id: 1, role: 'assistant', status: 'completed',
          content: `The edited image is saved at: \`${imagePath}\``, created_at: createdAt,
        } } },
      ]
      await route.fulfill({
        contentType: 'application/x-ndjson', body: frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
      })
    })
    const composer = page.getByPlaceholder('Plan, write, or ask anything…')
    await composer.fill('Edit this poster and save the image')
    await composer.press('Enter')
    const thumbnail = page.locator('.agent-tool-image-thumb')
    await expect(thumbnail).toBeVisible()
    await expect(page.getByTestId('agent-chat-messages')).toContainText('The edited image is saved at:')
    await composer.fill('Keep this follow-up draft')
    const chatURL = page.url()
    const popups: string[] = []
    page.on('popup', (popup) => popups.push(popup.url()))
    if (source === 'runtime URL') await thumbnail.press('Enter')
    else await thumbnail.click()

    const preview = page.locator('.workspace-file-viewer.is-active img')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('src', imageURL)
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(composer).toHaveValue('Keep this follow-up draft')
    await expect(page.getByTestId('agent-chat-messages')).toContainText('The edited image is saved at:')
    await expect(page).toHaveURL(chatURL)
    expect(popups).toEqual([])
    await preview.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy image', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('internal-image-preview.png') })
  })
}
