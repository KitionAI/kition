import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('desktop provider inputs keep native select-all and paste shortcuts', async ({ baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-shortcuts-'))
  const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL as string,
      KITION_DESKTOP_SKIP_API: 'true',
    },
  })

  try {
    const page = await app.firstWindow()
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/settings?section=providers', baseURL as string).toString(), {
      waitUntil: 'commit',
    })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)
    await page.getByRole('button', { name: /OpenAI/ }).click()
    const providerInput = page.getByLabel('API key').first()
    await expect(providerInput).toBeVisible({ timeout: 30_000 })

    await providerInput.click()
    await providerInput.press(`${shortcutModifier}+A`)
    await providerInput.type('CMD-A-REPLACED')
    await expect(providerInput).toHaveValue('CMD-A-REPLACED')

    await app.evaluate(({ clipboard }, value) => {
      clipboard.writeText(value)
    }, 'PASTED-BY-CMD-V')

    await providerInput.click()
    await providerInput.press(`${shortcutModifier}+A`)
    await providerInput.press(`${shortcutModifier}+V`)
    await expect(providerInput).toHaveValue('PASTED-BY-CMD-V')

    const desktopInfo = await page.evaluate(() => window.kitionDesktop?.DesktopInfo?.())
    expect(desktopInfo?.workspace_dir).toBeTruthy()
    const generatedImagePath = path.join(
      desktopInfo!.workspace_dir!,
      'Agent',
      'images',
      'clipboard-test.png',
    )
    await fs.mkdir(path.dirname(generatedImagePath), { recursive: true })
    await fs.writeFile(generatedImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await page.evaluate(async () => {
      await window.kitionDesktop?.CopyDocumentHtml?.({
        document_path: 'Articles/Publishing/article.md',
        html: '<article><img src="Agent/images/clipboard-test.png" alt="Generated"></article>',
        text: 'Generated',
      })
    })
    const publishingClipboard = await app.evaluate(({ clipboard }) => ({
      html: clipboard.readHTML(),
      text: clipboard.readText(),
    }))
    expect(publishingClipboard.html).toContain('src="data:image/png;base64,iVBORw=="')
    expect(publishingClipboard.html).not.toContain('Agent/images/clipboard-test.png')
    expect(publishingClipboard.text).toBe('Generated')

    const backendPublicOrigin = desktopInfo!.backend_base_url.replace(/\/api\/?$/, '')
    await page.evaluate(async ({ imageUrl }) => {
      await window.kitionDesktop?.CopyDocumentHtml?.({
        document_path: 'Articles/Publishing/article.md',
        html: `<article><img src="${imageUrl}" alt="Generated"></article>`,
        text: 'Generated from workspace URL',
      })
    }, {
      imageUrl: `${backendPublicOrigin}/workspace-files/Agent/images/clipboard-test.png`,
    })
    const publicUrlClipboard = await app.evaluate(({ clipboard }) => ({
      html: clipboard.readHTML(),
      text: clipboard.readText(),
    }))
    expect(publicUrlClipboard.html).toContain('src="data:image/png;base64,iVBORw=="')
    expect(publicUrlClipboard.text).toBe('Generated from workspace URL')

    await page.evaluate(() => {
      const pasteTarget = document.createElement('div')
      pasteTarget.contentEditable = 'true'
      pasteTarget.dataset.testid = 'publishing-paste-target'
      document.body.appendChild(pasteTarget)
      pasteTarget.focus()
    })
    await page.locator('[data-testid="publishing-paste-target"]').press(`${shortcutModifier}+V`)
    await expect(page.locator('[data-testid="publishing-paste-target"] img')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw==',
    )

    const publishingCopyMarkdown = 'Before\n\n![Generated](<Agent/images/clipboard-test.png>)\n\nAfter\n'
    await fs.writeFile(
      path.join(desktopInfo!.workspace_dir!, 'Publishing copy.md'),
      publishingCopyMarkdown,
    )
    await page.goto(new URL('/documents', baseURL as string).toString(), {
      waitUntil: 'commit',
    })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('document-tree')).toBeVisible({ timeout: 30_000 })
    await page.locator('.document-tree-row', { hasText: 'Publishing copy' }).first().click()
    await page.getByRole('button', { name: 'Reading view' }).click()
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
    await expect(page.locator('.document-editor .cm-selectionLayer')).toHaveCount(0)
    const editorContent = page.locator('.document-editor .cm-content').first()
    await expect(editorContent).toContainText('Before')
    await editorContent.click()
    await editorContent.press(`${shortcutModifier}+A`)
    await editorContent.press(`${shortcutModifier}+C`)

    await expect(page.getByText('Copied with images embedded')).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readHTML()))
      .toContain('src="data:image/png;base64,iVBORw=="')
    const copiedArticle = await app.evaluate(({ clipboard }) => ({
      html: clipboard.readHTML(),
      text: clipboard.readText(),
    }))
    expect(copiedArticle.html).toContain('Before')
    expect(copiedArticle.html).toContain('After')
    expect(copiedArticle.html).not.toContain('![Generated]')
    expect(copiedArticle.html).not.toContain('Agent/images/clipboard-test.png')
    expect(copiedArticle.text).toBe(publishingCopyMarkdown)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
