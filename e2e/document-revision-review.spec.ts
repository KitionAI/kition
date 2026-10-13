import { expect, test, type Page } from '@playwright/test'
import en from '../src/i18n/locales/en-US/document.json' with { type: 'json' }
import zh from '../src/i18n/locales/zh-CN/document.json' with { type: 'json' }
import workspaceCopy from '../src/i18n/locales/en-US/workspace.json' with { type: 'json' }
import { mockAgentTurn, type AgentTurnScript } from './helpers/agentStream'
import { mockDocumentBridge } from './helpers/documentBridge'
import { DEFAULT_DOC_PATH, mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

/** Desktop settings with a model, so the Agent panel can send a turn. */
const agentSettings = JSON.stringify({
  general: { theme: 'light', language: 'en-US', restoreWorkspaceOnLaunch: true, confirmBeforeQuit: true, autoCheckUpdates: true },
  shortcuts: [],
  providers: {
    openai: {
      kind: 'openai', enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key',
      accessToken: '', refreshToken: '', modelsPath: '/models', authHeader: '', authScheme: 'bearer',
      wireApi: 'responses', reasoningEffort: 'medium', disableResponseStorage: true,
      discoveredModels: ['gpt-test'], lastSyncedAt: '2026-08-27T12:00:00.000Z',
    },
  },
  models: {
    activeProvider: 'openai',
    selectedModels: { openai: 'gpt-test' },
    preferredDefaultModel: 'gpt-test',
    preferredChatModel: 'gpt-test',
    preferredWritingModel: 'gpt-test',
  },
})

/** Captures the external-change subscription so the test can report a file change like the watcher does. */
async function captureExternalChanges(page: Page) {
  await page.addInitScript(() => {
    const target = window as any
    target.kitionDesktop.documentExternalChangeEvent = 'test:document-change'
    target.kitionDesktop.EventsOn = (name: string, handler: (payload: unknown) => void) => {
      if (name !== 'test:document-change') return () => {}
      ;(target.externalChangeHandlers ??= []).push(handler)
      return () => {}
    }
    target.emitExternalChange = (payload: unknown) => {
      for (const handler of target.externalChangeHandlers ?? []) handler(payload)
    }
    target.kitionDesktop.OpenWorkspaceFile = async (request: { path: string }) => {
      target.openedInSystem = await target.kitionDesktop.ReadWorkspaceDocument(request)
      return ''
    }
  })
}

/** Opens the Agent panel and sends `text` in a new chat. */
async function askAgent(page: Page, text: string) {
  await page.getByTestId('agent-floating-launcher').click()
  await page.locator('button[aria-label="New chat"]').click()
  await page.locator('.agent-ai-composer textarea').fill(text)
  await page.locator('.agent-ai-send').click()
}

/**
 * Mounts the workspace on `original` with an Agent whose turn edits `path` the way the runtime
 * does for a document a window has open: `document/apply` over the bridge, then the tool result.
 */
async function mountWithLiveAgentEdit(page: Page, edit: { path?: string; content: string; extra?: Record<string, string> }) {
  const path = edit.path ?? DEFAULT_DOC_PATH
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, original, edit.extra ?? {}, DEFAULT_DOC_PATH, { secureValues: { 'kition.desktop.settings.v1': agentSettings } })
  await captureExternalChanges(page)
  const bridge = await mockDocumentBridge(page)
  const answers: unknown[] = []
  await mockAgentTurn(page, async (turn: AgentTurnScript) => {
    const answer = await bridge.request('document/apply', { path, content: edit.content, tool: 'document_write', turnId: 'turn-1' })
    answers.push(answer.result ?? answer.error)
    turn.tool('call_write', 'document_write', { path, content: edit.content }, { path, live: true })
    turn.nextStep()
    turn.reply('Updated the pilot numbers.')
  })
  return { bridge, answers }
}

/** The editor's text (its document, without the removed text it shows under review). */
const editorText = (page: Page) => page.evaluate(() => (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view.state.doc.toString() as string)

/**
 * Runs the editor's own undo (the document replica's history). Headless Chromium drops the first
 * Cmd+Z of a session before it reaches CodeMirror's keymap (see the selection translation spec).
 */
const undoInEditor = (page: Page) => page.evaluate(async (modulePath) => {
  const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
  const history: any = await import(/* @vite-ignore */ new URL(modulePath, window.location.href).href)
  return history.undoDocument(view) as boolean
}, '/src/features/document/kdm/documentHistory.ts')

const readStored = (page: Page, path = DEFAULT_DOC_PATH) => page.evaluate(async (target) => (await (window as any).kitionDesktop.ReadWorkspaceDocument({ path: target })).content as string, path)

const original = '# Pilot update\n\nThe pilot starts in October with 30 teams.\n\n## Evidence\n\nThe survey is still pending.\n\n## Next steps\n\nContact the Pilot Team.\n'
const proposed = original.replace('October with 30', 'November with 24').replace('The survey is still pending.', '18 teams responded. 12 requested citations.')

test('merges an edit made outside Kition into the open document', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, original)
  await captureExternalChanges(page)
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('October with 30')
  await page.evaluate(async ({ path, content }) => {
    const target = window as any
    await target.kitionDesktop.WriteWorkspaceDocument({ path, content })
    target.emitExternalChange({ path, eventType: 'change', mtimeMs: Date.now() })
  }, { path: DEFAULT_DOC_PATH, content: proposed })
  // D4: the change arrives as a text change, without a review or a reload.
  await expect(page.locator('.cm-content')).toContainText('November with 24')
  await expect(page.locator('.cm-content')).toContainText('18 teams responded.')
  await expect(page.getByTestId('document-revision-review')).toHaveCount(0)
})

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`reviews the Agent's Markdown changes without covering the text (${locale})`, async ({ page }, testInfo) => {
    const copy = locale === 'zh-CN' ? zh.revision : en.revision
    await page.setViewportSize({ width: 1440, height: 1000 })
    await mountWithLiveAgentEdit(page, { content: proposed })
    await page.goto('/')
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await askAgent(page, 'Update the pilot numbers')
    await expect(page.locator('.agent-message.is-assistant')).toContainText('Updated the pilot numbers.')
    // The edit is in the text already; the bar opens the review panel on it.
    await page.getByTestId('document-agent-review').getByRole('button', { name: en.revision.title, exact: true }).click()
    // The review at a narrow width too: collapse the Agent panel first.
    if (locale === 'zh-CN') {
      await page.getByRole('button', { name: 'Collapse AI Chat', exact: true }).click()
      await page.setViewportSize({ width: 600, height: 1000 })
    }
    await page.evaluate(async (language) => {
      const modulePath = '/src/i18n/index.ts'
      const { setCurrentLocale } = await import(modulePath)
      await setCurrentLocale(language)
    }, locale)
    const review = page.getByTestId('document-revision-review')
    await expect(review).toBeVisible()
    await expect(review.locator('.document-revision-change-block')).toHaveCount(2)
    await expect(review.locator('mark.is-added').first()).toHaveText('November')
    await expect(review.locator('mark.is-removed').first()).toHaveText('October')
    const geometry = await review.locator('.document-revision-change-block').first().evaluate((block) => {
      const actions = block.querySelector('.document-revision-change-actions')!.getBoundingClientRect()
      const comparison = block.querySelector('.document-revision-comparison')!.getBoundingClientRect()
      return { noOverlap: actions.bottom <= comparison.top, fits: block.scrollWidth <= block.clientWidth + 2 }
    })
    expect(geometry).toEqual({ noOverlap: true, fits: true })
    await review.getByLabel(copy.changesOnly).check()
    await expect(review.locator('details').first()).not.toHaveAttribute('open')
    await review.locator('details summary').first().click()
    await expect(review.locator('details').first()).toHaveAttribute('open', '')
    await review.getByRole('button', { name: copy.inline, exact: true }).click()
    await expect(review.locator('.document-revision-line.is-added').first()).toContainText('November')
    await review.getByRole('button', { name: copy.split, exact: true }).click()
    await review.screenshot({ path: testInfo.outputPath(`review-${locale}.png`) })
    await review.getByRole('button', { name: copy.reject, exact: true }).first().click()
    await review.getByRole('button', { name: copy.acceptRemaining, exact: true }).click()
    await expect(review).toBeHidden()
    await expect(page.getByTestId('document-agent-review')).toBeHidden()
    const expected = original.replace('The survey is still pending.', '18 teams responded. 12 requested citations.')
    await expect.poll(() => readStored(page)).toBe(expected)
    await expect(page.locator('.cm-content')).toContainText('October with 30')

    if (locale === 'en-US') {
      await page.getByRole('button', { name: workspaceCopy.topbar.more, exact: true }).click()
      await page.getByRole('button', { name: workspaceCopy.itemMenu.openInSystem, exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as any).openedInSystem?.content)).toBe(expected)
    }
  })
}

test('shows the Agent’s edit of the open document live; one Undo takes it back', async ({ page }, testInfo) => {
  const { bridge, answers } = await mountWithLiveAgentEdit(page, { content: proposed })
  await page.goto('/')
  await expect(page.locator('.cm-content')).toContainText('October with 30')
  await expect.poll(() => bridge.openPaths()).toContain(DEFAULT_DOC_PATH)
  await askAgent(page, 'Update the pilot numbers')
  await expect(page.locator('.agent-message.is-assistant')).toContainText('Updated the pilot numbers.')
  expect(answers).toEqual([{ applied: true, content: proposed }])
  // Live: in the text, marked, and saved; no review panel covers the text.
  await expect.poll(() => editorText(page)).toContain('November with 24 teams.')
  await expect(page.locator('.cm-agent-review-added').first()).toHaveText('November')
  await expect(page.locator('.cm-agent-review-removed').first()).toHaveText('October')
  await expect(page.getByTestId('document-agent-review')).toBeVisible()
  await expect(page.getByTestId('document-revision-review')).toHaveCount(0)
  expect(await readStored(page)).toBe(proposed)
  await page.locator('.workspace-document-shell').screenshot({ path: testInfo.outputPath('live-edit.png') })

  await page.locator('.cm-line', { hasText: 'Contact the Pilot Team.' }).click()
  expect(await undoInEditor(page)).toBe(true)
  await expect.poll(() => editorText(page)).toBe(original)
  await expect(page.locator('.cm-content')).toContainText('October with 30')
  await expect(page.getByTestId('document-agent-review')).toBeHidden()
  await expect(page.locator('.cm-agent-review-added')).toHaveCount(0)
  await expect.poll(() => readStored(page)).toBe(original)
})

test('rejects the Agent’s edit and keeps what the person typed meanwhile', async ({ page }) => {
  await mountWithLiveAgentEdit(page, { content: proposed })
  await page.goto('/')
  await expect(page.locator('.cm-content')).toContainText('October with 30')
  await askAgent(page, 'Update the pilot numbers')
  await expect.poll(() => editorText(page)).toContain('November with 24 teams.')
  // The person types at the end while the edit waits for review.
  await page.locator('.cm-line', { hasText: 'Contact the Pilot Team.' }).click()
  await page.evaluate(() => {
    const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    view.focus()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await page.keyboard.type('Typed meanwhile.')
  await expect.poll(() => editorText(page)).toBe(`${proposed}Typed meanwhile.`)
  await page.getByTestId('document-agent-review').getByRole('button', { name: en.revision.rejectAll, exact: true }).click()
  await expect(page.getByTestId('document-agent-review')).toBeHidden()
  await expect.poll(() => editorText(page)).toBe(`${original}Typed meanwhile.`)
  await expect.poll(() => readStored(page)).toBe(`${original}Typed meanwhile.`)
})

test('marks a background tab the Agent changed and reviews the change there', async ({ page }) => {
  const other = 'notes.md'
  await mountWithLiveAgentEdit(page, { content: proposed, extra: { [other]: '# Notes\n\nNothing yet.\n' } })
  await page.goto('/')
  await expect(page.locator('.cm-content')).toContainText('October with 30')
  await page.locator('.document-tree-row', { hasText: 'notes' }).first().click()
  await expect(page.locator('.cm-content')).toContainText('Nothing yet.')
  await askAgent(page, 'Update the pilot numbers')
  await expect(page.locator('.agent-message.is-assistant')).toContainText('Updated the pilot numbers.')
  const pilotTab = page.locator('.document-tab-list .document-tab[data-tab-title="table-test"]')
  await expect(pilotTab.getByTestId('document-tab-agent-changed')).toBeVisible()
  await expect.poll(() => readStored(page)).toBe(proposed)
  await pilotTab.click()
  await expect.poll(() => editorText(page)).toContain('November with 24 teams.')
  await expect(page.getByTestId('document-agent-review')).toBeVisible()
  await expect(page.locator('.cm-agent-review-added').first()).toHaveText('November')
  await expect(pilotTab.getByTestId('document-tab-agent-changed')).toHaveCount(0)
  await page.getByTestId('document-agent-review').getByRole('button', { name: en.revision.acceptAll, exact: true }).click()
  await expect(page.getByTestId('document-agent-review')).toBeHidden()
  await expect(page.locator('.cm-agent-review-added')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('November with 24')
})
