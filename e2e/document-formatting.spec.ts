import { expect, test } from '@playwright/test'
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

test('renders padded bold labels and inline bold inside headings in existing notes', async ({ page }) => {
  const source = '## Company | **ERP**\n\n**Company: **Details\n\n**Deployment:**Details\n\n### **Use cases: **\n\n- **Business process**\n\nEnd\n'
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, source)
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.locator('.cm-line', { hasText: /^End$/ }).click()
  await expect(editor).not.toContainText('**')
  for (const text of ['ERP', 'Company:', 'Deployment:', 'Use cases:', 'Business process']) {
    await expect(editor.locator('.cm-md-strong').filter({ hasText: text }).first()).toBeVisible()
  }
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: '/tmp/kition-bold-labels.png' })
  const saved = await page.evaluate(() => window.kitionDesktop!.ReadWorkspaceDocument!({ path: 'table-test.md' }))
  expect(saved.content).toBe(source)
})

test('places newly pasted images under the current note folder and saves relative links', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Images\n\n')
  await page.addInitScript(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => ({ mime_type: 'image/png', base64_content: 'AQID' })
    window.kitionDesktop!.ImportWorkspaceFile = async (request) => {
      if (request.folder !== 'attachments/table-test.md') throw new Error('Wrong attachment folder')
      return { imported_path: `${request.folder}/local-image.png` }
    }
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<p>Caption</p><img src="https://example.invalid/image.png">')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.locator('.cm-md-image img')).toHaveAttribute('src', /workspace-files\/attachments\/table-test\.md\/local-image\.png/)
  await expect.poll(async () => (await page.evaluate(() => window.kitionDesktop!.ReadWorkspaceDocument!({ path: 'table-test.md' }))).content)
    .toContain('attachments/table-test.md/local-image.png')
})
