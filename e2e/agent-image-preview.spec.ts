import { expect, test } from '@playwright/test'
import { mockAgentTurn } from './helpers/agentStream'
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

    await mockAgentTurn(page, (turn) => {
      turn.tool('call_image', 'image_generation', {},
        source === 'workspace path' ? { path: imagePath } : { images: [{ url: imageURL }] })
      turn.reply(`The edited image is saved at: \`${imagePath}\``)
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
