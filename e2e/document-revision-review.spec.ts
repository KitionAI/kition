import { expect, test, type Page } from '@playwright/test'
import en from '../src/i18n/locales/en-US/document.json' with { type: 'json' }
import zh from '../src/i18n/locales/zh-CN/document.json' with { type: 'json' }
import workspaceCopy from '../src/i18n/locales/en-US/workspace.json' with { type: 'json' }
import { mockAgentTurn } from './helpers/agentStream'
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
    await mockLocalWorkspaceApi(page)
    await mockDesktopBridge(page, original, {}, DEFAULT_DOC_PATH, { secureValues: { 'kition.desktop.settings.v1': agentSettings } })
    await captureExternalChanges(page)
    await mockAgentTurn(page, async (turn) => {
      // The runtime is outside this test: write the Agent's edit here, then report the patch.
      await page.evaluate(async ({ path, content }) => {
        await (window as any).kitionDesktop.WriteWorkspaceDocument({ path, content })
      }, { path: DEFAULT_DOC_PATH, content: proposed })
      turn.tool('call_patch', 'apply_patch', { path: DEFAULT_DOC_PATH }, { file_ops: [{ kind: 'update', path: DEFAULT_DOC_PATH }] })
      turn.nextStep()
      turn.reply('Updated the pilot numbers.')
    })
    await page.goto('/')
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await page.getByTestId('agent-floating-launcher').click()
    await page.locator('button[aria-label="New chat"]').click()
    await page.locator('.agent-ai-composer textarea').fill('Update the pilot numbers')
    await page.locator('.agent-ai-send').click()
    await expect(page.locator('.agent-message.is-assistant')).toContainText('Updated the pilot numbers.')
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
    const stored = await page.evaluate(async () => (window as any).kitionDesktop.ReadWorkspaceDocument({ path: 'table-test.md' }))
    expect(stored.content).toBe(original.replace('The survey is still pending.', '18 teams responded. 12 requested citations.'))

    if (locale === 'en-US') {
      await page.getByRole('button', { name: workspaceCopy.topbar.more, exact: true }).click()
      await page.getByRole('button', { name: workspaceCopy.itemMenu.openInSystem, exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as any).openedInSystem?.content)).toBe(stored.content)
    }
  })
}
