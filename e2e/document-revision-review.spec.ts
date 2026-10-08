import { expect, test } from '@playwright/test'
import en from '../src/i18n/locales/en-US/document.json' with { type: 'json' }
import zh from '../src/i18n/locales/zh-CN/document.json' with { type: 'json' }
import workspaceCopy from '../src/i18n/locales/en-US/workspace.json' with { type: 'json' }
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const original = '# Pilot update\n\nThe pilot starts in October with 30 teams.\n\n## Evidence\n\nThe survey is still pending.\n\n## Next steps\n\nContact the Pilot Team.\n'
const proposed = original.replace('October with 30', 'November with 24').replace('The survey is still pending.', '18 teams responded. 12 requested citations.')

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`reviews Markdown changes without covering the text (${locale})`, async ({ page }, testInfo) => {
    const copy = locale === 'zh-CN' ? zh.revision : en.revision
    await page.setViewportSize({ width: locale === 'zh-CN' ? 600 : 1440, height: 1000 })
    await mockLocalWorkspaceApi(page)
    await mockDesktopBridge(page, original)
    await page.addInitScript(() => {
      const target = window as any
      target.kitionDesktop.documentExternalChangeEvent = 'test:document-change'
      target.kitionDesktop.EventsOn = (name: string, handler: unknown) => {
        if (name === 'test:document-change') target.onRevisionChange = handler
        return () => {}
      }
      target.kitionDesktop.OpenWorkspaceFile = async (request: { path: string }) => {
        target.openedInSystem = await target.kitionDesktop.ReadWorkspaceDocument(request)
        return ''
      }
    })
    await page.goto('/')
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await page.evaluate(async ({ language, content }) => {
      const modulePath = '/src/i18n/index.ts'
      const { setCurrentLocale } = await import(modulePath)
      await setCurrentLocale(language)
      const target = window as any
      await target.kitionDesktop.WriteWorkspaceDocument({ path: 'table-test.md', content })
      target.onRevisionChange({ path: 'table-test.md', eventType: 'change', mtimeMs: Date.now() })
    }, { language: locale, content: proposed })
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
