import { expect, test, type Page } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const DOC = [
  '# Traffic review',
  '',
  'When organic traffic to a page is down, check the phrases for which it ranks.',
  '',
  'Closing paragraph.',
  '',
].join('\n')
const SOURCE = 'When organic traffic to a page is down, check the phrases for which it ranks.'
const TRANSLATION = 'Wenn der organische Traffic sinkt, pruefen Sie die Suchbegriffe.'

const MODEL_SETTINGS = {
  'kition.desktop.settings.v1': JSON.stringify({
    models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'example-model' } },
    providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: '', apiKey: '', discoveredModels: ['example-model'] } },
  }),
  'desktop.provider.openai.apiKey.v1': 'sk-test',
}

async function openDocument(page: Page, secureValues: Record<string, string>) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  await mockLocalWorkspaceApi(page)
  // Registered after the generic API mock: Playwright prefers the newest matching route.
  await page.route('**/api/v1/ai/chat', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: { code: 200, message: 'success', data: { content: TRANSLATION, model: 'example-model' } } })
  })
  await mockDesktopBridge(page, DOC, {}, 'reference/traffic.md', { secureValues })
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(() => Boolean((document.querySelector('.cm-editor .cm-content') as any)?.cmTile?.root?.view))
  return requests
}

async function selectSource(page: Page) {
  // Click into the text first, as a user would; the editor only handles
  // keyboard shortcuts such as undo after a real pointer interaction.
  await page.locator('.cm-line', { hasText: 'When organic traffic' }).first().click()
  await page.evaluate((text) => {
    const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    const from = view.state.doc.toString().indexOf(text)
    view.focus()
    view.dispatch({ selection: { anchor: from, head: from + text.length } })
  }, SOURCE)
}

const readDoc = (page: Page) => page.evaluate(() => (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view.state.doc.toString())

test('translates a selection inline, replaces it, and undoes in one step', async ({ page }) => {
  let commandsModuleUrl = ''
  page.on('request', (request) => {
    if (request.url().includes('@codemirror_commands.js')) commandsModuleUrl = request.url()
  })
  const requests = await openDocument(page, MODEL_SETTINGS)
  await selectSource(page)

  await page.getByTestId('document-translate-menu').click()
  await page.getByRole('menuitem', { name: /Deutsch/ }).click()

  await expect(page.getByTestId('document-translation-result')).toHaveText(TRANSLATION)
  expect(requests).toHaveLength(1)
  expect(requests[0].messages[0].content).toContain('German')
  expect(requests[0].messages[1].content).toBe(SOURCE)

  await page.getByTestId('document-translation-replace').click()
  await expect(page.getByTestId('document-translation-card')).toHaveCount(0)
  expect(await readDoc(page)).toContain(TRANSLATION)
  expect(await readDoc(page)).not.toContain(SOURCE)

  // Run the app's own undo command. Headless Chromium drops the first Cmd+Z of
  // a session before it reaches CodeMirror's keymap, so the key path is not
  // reliable here; the history itself is what this asserts.
  const undone = await page.evaluate(async (url) => {
    const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    const commands: any = await import(url)
    return commands.undo(view)
  }, commandsModuleUrl)
  expect(undone).toBe(true)
  expect(await readDoc(page)).toContain(SOURCE)
  expect(await readDoc(page)).not.toContain(TRANSLATION)
})

test('keeps the original with Insert below and remembers a new default language', async ({ page }) => {
  await openDocument(page, MODEL_SETTINGS)
  await selectSource(page)

  await page.getByTestId('document-translate-menu').click()
  await page.getByTestId('document-translate-make-default').click()
  await page.getByRole('menuitem', { name: /Deutsch/ }).click()
  await expect(page.getByTestId('document-translation-result')).toHaveText(TRANSLATION)
  await page.getByTestId('document-translation-insert').click()

  const doc = await readDoc(page)
  expect(doc).toContain(`${SOURCE}\n\n${TRANSLATION}\n\nClosing paragraph.`)

  await selectSource(page)
  await expect(page.getByTestId('document-translate-button')).toHaveAttribute('title', /Deutsch/)
})

test('asks to configure a model when none is set up', async ({ page }) => {
  const requests = await openDocument(page, {})
  await selectSource(page)
  await page.getByTestId('document-translate-button').click()
  await expect(page.getByTestId('document-translation-error')).toBeVisible()
  await expect(page.getByTestId('document-translation-card').getByRole('button', { name: 'Configure model' })).toBeVisible()
  expect(requests).toHaveLength(0)
})

test('opens the translation card with Cmd/Ctrl+Alt+T', async ({ page }) => {
  const requests = await openDocument(page, MODEL_SETTINGS)
  await selectSource(page)
  // CodeMirror maps Mod from the page's reported platform, not the host OS.
  const isMacPage = await page.evaluate(() => /Mac/.test(navigator.platform))
  await page.keyboard.press(isMacPage ? 'Meta+Alt+t' : 'Control+Alt+t')
  await expect(page.getByTestId('document-translation-result')).toHaveText(TRANSLATION)
  expect(requests).toHaveLength(1)
})
