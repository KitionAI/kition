import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const FEISHU_IMAGE_HTML = '<meta charset="utf-8"><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image-id/?preview_type=16" alt="image-id">'
const TARGET_DOCUMENT_PATH = 'Articles/Nested/Paste target.md'

test('pastes a native image copied from a Feishu-style editor clipboard', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('https://internal-api-drive-stream.feishu.cn/**', (route) => route.fulfill({ status: 403, body: '' }))
    await page.goto(new URL('/documents', baseURL as string).toString(), { waitUntil: 'commit' })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)

    await page.evaluate(async () => {
      await window.kitionDesktop?.ImportWorkspaceFile?.({
        folder: 'Articles/Nested',
        filename: 'Paste target.md',
        base64_content: btoa('# Paste target\n\n'),
      })
      window.localStorage.setItem('kition.document.last-active-path.v1', 'Articles/Nested/Paste target.md')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('workspace-document-inline-title')).toContainText('Paste target')

    const png = await fs.readFile(path.join(process.cwd(), 'public', 'logo-mark.png'))
    host.clipboard.image = { mime_type: 'image/png', base64_content: png.toString('base64') }
    const nativeClipboardImage = await page.evaluate(() => window.kitionDesktop!.ReadClipboardImage!())
    expect(nativeClipboardImage?.mime_type).toBe('image/png')

    const editorContent = page.locator('.document-editor .cm-content').first()
    await expect(editorContent).toBeVisible({ timeout: 30_000 })
    await editorContent.click()
    await editorContent.evaluate((element, html) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/html', html)
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, FEISHU_IMAGE_HTML)

    await expect(page.locator('.cm-md-image img')).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => fs.readFile(path.join(host.root, TARGET_DOCUMENT_PATH), 'utf8'))
      .toContain('](<../../attachments/Articles/Nested/Paste target.md/pasted-')
    await expect.poll(async () => fs.readdir(path.join(host.root, 'attachments', 'Articles', 'Nested', 'Paste target.md')))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^pasted-.*\.png$/)]))
    expect(host.calls.some((call) => call.command === 'read_clipboard_image')).toBe(true)
  } finally {
    await host.dispose()
  }
})
