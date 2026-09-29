import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import electronPath from 'electron'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const DOC = ['# Traffic review', '', 'When organic traffic to a page is down, check the phrases for which it ranks.', '', 'Closing paragraph.', ''].join('\n')
const SOURCE = 'When organic traffic to a page is down, check the phrases for which it ranks.'
const TRANSLATION = 'Wenn der organische Traffic sinkt, pruefen Sie die Suchbegriffe.'

async function seedSettings(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (value) => {
    const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop
    await bridge!.StoreSecureValue(
      'kition.desktop.settings.v1',
      JSON.stringify({
        general: { theme: value, language: 'en-US', restoreWorkspaceOnLaunch: true, confirmBeforeQuit: true, autoCheckUpdates: true },
        shortcuts: [],
        providers: {
          openai: {
            kind: 'openai', enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key',
            accessToken: '', refreshToken: '', modelsPath: '/models', authHeader: '', authScheme: 'bearer',
            wireApi: 'responses', reasoningEffort: 'medium', disableResponseStorage: true, discoveredModels: ['gpt-test'],
            lastSyncedAt: '2026-09-29T00:00:00.000Z',
          },
        },
        models: {
          activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-test' },
          preferredDefaultModel: 'gpt-test', preferredChatModel: 'gpt-test', preferredWritingModel: 'gpt-test',
        },
      }),
    )
  }, theme)
}

const view = (page: Page) => page.locator('.cm-editor .cm-content')
const readDoc = (page: Page) =>
  page.evaluate(() => (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view.state.doc.toString())

async function selectSource(page: Page) {
  await page.locator('.cm-line', { hasText: 'When organic traffic' }).first().click()
  await page.evaluate((text) => {
    const editor = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    const from = editor.state.doc.toString().indexOf(text)
    editor.focus()
    editor.dispatch({ selection: { anchor: from, head: from + text.length } })
  }, SOURCE)
}

test('translates a selection in the desktop client with keyboard undo and both themes', async ({ baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-translation-'))
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: { ...process.env, KITION_ELECTRON_TEST_DATA_DIR: profile, KITION_ELECTRON_DEV_SERVER_URL: baseURL!, KITION_DESKTOP_SKIP_API: 'true' },
  })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/ai/chat', (route) =>
      route.fulfill({ json: { code: 200, message: 'success', data: { content: TRANSLATION, model: 'gpt-test' } } }),
    )
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await seedSettings(page, 'light')
    await page.evaluate(async (markdown) => {
      const bridge = (window as typeof window & { kitionDesktop?: Record<string, any> }).kitionDesktop!
      const created = await bridge.CreateWorkspaceDocument({ title: 'Traffic review', folder: '', platform: 'Research', format: 'markdown' })
      await bridge.WriteWorkspaceDocument({ path: created.path, content: markdown })
      return created.path as string
    }, DOC)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.document-tree-row', { hasText: 'Traffic review' }).first().click()
    await expect(page.locator('.cm-line', { hasText: 'When organic traffic' })).toBeVisible({ timeout: 15_000 })

    await selectSource(page)
    await page.getByTestId('document-translate-menu').click()
    await page.getByRole('menuitem', { name: /Deutsch/ }).click()
    await expect(page.getByTestId('document-translation-result')).toHaveText(TRANSLATION)
    const card = (await page.getByTestId('document-translation-card').boundingBox())!
    expect(card.x).toBeGreaterThanOrEqual(0)
    // The card keeps a margin from the window edge.
    expect(card.x + card.width).toBeLessThanOrEqual(1280 - 16)
    // Keyboard navigation activates :focus-visible after the pointer-driven menu selection.
    const replaceButton = page.getByTestId('document-translation-replace')
    await expect(replaceButton).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(replaceButton).toBeFocused()
    await expect.poll(() => replaceButton.evaluate((element) => {
      const style = getComputedStyle(element)
      return { outlineStyle: style.outlineStyle, shadow: style.boxShadow }
    })).toEqual({ outlineStyle: expect.not.stringMatching(/^auto$/), shadow: expect.stringContaining('86, 69, 212') })
    await page.screenshot({ path: testInfo.outputPath('translation-light.png') })

    await page.getByTestId('document-translation-replace').click()
    await expect(page.getByTestId('document-translation-card')).toHaveCount(0)
    expect(await readDoc(page)).toContain(TRANSLATION)
    // Focus returns to the editor, so the real keyboard undo reaches CodeMirror.
    await expect(view(page)).toBeFocused()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
    await expect.poll(() => readDoc(page)).toContain(SOURCE)
    expect(await readDoc(page)).not.toContain(TRANSLATION)

    await seedSettings(page, 'dark')
    await page.evaluate(async () => {
      const { loadDesktopSettings, saveDesktopSettings } = await import(/* @vite-ignore */ ['/src/services', 'desktopSettings.ts'].join('/'))
      const settings = await loadDesktopSettings()
      await saveDesktopSettings({ ...settings, general: { ...settings.general, theme: 'dark' } })
    })
    await selectSource(page)
    await page.getByTestId('document-translate-button').click()
    await expect(page.getByTestId('document-translation-result')).toHaveText(TRANSLATION)
    await page.screenshot({ path: testInfo.outputPath('translation-dark.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('document-translation-card')).toHaveCount(0)
    await expect(view(page)).toBeFocused()
  } finally {
    await app.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})
