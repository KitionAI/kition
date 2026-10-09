import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('desktop shortcuts keep select-all in inputs and copy articles through the desktop clipboard', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/settings?section=providers', baseURL as string).toString(), { waitUntil: 'commit' })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)
    // Editor shortcuts follow the page's reported platform; native input
    // editing and clipboard commands follow the host operating system.
    const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'))
    await page.getByRole('button', { name: /OpenAI/ }).click()
    const providerInput = page.getByLabel('API key').first()
    await expect(providerInput).toBeVisible({ timeout: 30_000 })
    await providerInput.fill('ORIGINAL-KEY')
    await providerInput.press('ControlOrMeta+a')
    await providerInput.pressSequentially('CMD-A-REPLACED')
    await expect(providerInput).toHaveValue('CMD-A-REPLACED')

    const imagePath = path.join(host.root, 'Agent', 'images', 'clipboard-test.png')
    await fs.mkdir(path.dirname(imagePath), { recursive: true })
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const markdown = 'Before\n\n![Generated](<Agent/images/clipboard-test.png>)\n\nAfter\n'
    await fs.writeFile(path.join(host.root, 'Publishing copy.md'), markdown)

    await page.goto(new URL('/documents', baseURL as string).toString(), { waitUntil: 'commit' })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('document-tree')).toBeVisible({ timeout: 30_000 })
    await page.locator('.document-tree-row', { hasText: 'Publishing copy' }).first().click()
    await page.getByRole('button', { name: 'Reading view' }).click()
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
    const editorContent = page.locator('.document-editor .cm-content').first()
    await expect(editorContent).toContainText('Before')
    await editorContent.click()
    await editorContent.press(`${modifier}+a`)
    await editorContent.press('ControlOrMeta+c')

    await expect(page.getByText('Copied with images embedded')).toBeVisible({ timeout: 5_000 })
    const copy = host.calls.find((call) => call.command === 'copy_document_html')
    expect(copy?.args.request).toMatchObject({ document_path: 'Publishing copy.md' })
    expect(host.clipboard.html).toContain('Before')
    expect(host.clipboard.html).toContain('After')
    expect(host.clipboard.html).not.toContain('![Generated]')
    expect(host.clipboard.html).toMatch(/<img[^>]+clipboard-test\.png/)
    expect(host.clipboard.text).toBe(markdown)
  } finally {
    await host.dispose()
  }
})
