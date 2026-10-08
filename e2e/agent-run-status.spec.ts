import { expect, test } from '@playwright/test'
import enAgent from '../src/i18n/locales/en-US/agent.json' with { type: 'json' }
import zhAgent from '../src/i18n/locales/zh-CN/agent.json' with { type: 'json' }
import { openWhiteboardFixture } from './helpers/whiteboard'

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`keeps interrupted work and localized status visible (${locale})`, async ({ page }) => {
    const copy = locale === 'zh-CN' ? zhAgent : enAgent
    await page.setViewportSize({ width: locale === 'zh-CN' ? 1100 : 1440, height: 900 })
    await openWhiteboardFixture(page)
    await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
    const newChat = page.getByRole('button', { name: 'New chat' })
    if (await newChat.isVisible().catch(() => false)) await newChat.click()
    await page.evaluate(async (language) => {
      const settingsPath = '/src/services/desktopSettings.ts'
      const i18nPath = '/src/i18n/index.ts'
      const { loadDesktopSettings, saveDesktopSettings } = await import(settingsPath)
      const { setCurrentLocale } = await import(i18nPath)
      const settings = await loadDesktopSettings()
      await saveDesktopSettings({ ...settings, general: { ...settings.general, theme: 'light', language } })
      await setCurrentLocale(language)
    }, locale)
    let calls = 0
    await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
      calls += 1
      const sessionId = Number(route.request().url().match(/sessions\/(\d+)/)![1])
      const created = new Date().toISOString()
      const frames = [
        { type: 'user_message', chat_message: { id: 73, session_id: sessionId, user_id: 1, role: 'user', content: 'Write a pilot draft', status: 'completed', created_at: created } },
        { type: 'artifact', artifact: { id: 9, session_id: sessionId, user_id: 1, path: 'Pilot draft.md', kind: 'markdown', created_at: created } },
        { type: 'model_delta', delta: 'The saved draft covers the pilot.' },
      ]
      await route.fulfill({ contentType: 'application/x-ndjson', body: frames.map((frame) => JSON.stringify(frame)).join('\n') })
    })
    const panel = page.locator('.agent-chat-panel').last()
    const composer = panel.locator('textarea').last()
    await composer.fill('Write a pilot draft')
    await composer.press('Enter')
    await expect(panel.locator('.agent-run-log')).toContainText(copy.timeline.activity.completionUnknown)
    await expect(panel.locator('.agent-run-log')).toContainText(copy.timeline.activity.interruptedDetail)
    await expect(panel.locator('.agent-artifact')).toContainText('Pilot draft.md')
    await expect(panel.locator('.agent-message.is-assistant')).toContainText('The saved draft covers the pilot.')
    await expect(panel.locator('.agent-run-log-item.is-running')).toHaveCount(0)
    await expect(panel.locator('.agent-run-log')).not.toContainText(copy.timeline.activity.taskCompleted)
    await expect(composer).toBeEnabled()
    expect(calls).toBe(1)
    await panel.screenshot({ path: `test-results/agent-interrupted-${locale}.png` })
  })
}
