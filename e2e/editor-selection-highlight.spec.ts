import { expect, test } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const PARAGRAPH = 'Selected paragraph starts here and continues across several wrapped lines. '.repeat(5)

for (const firstBlock of ['quote', 'code', 'paragraph'] as const) {
  test(`selection covers wrapped paragraphs after a leading ${firstBlock}`, async ({ page }) => {
    const prefix = firstBlock === 'quote' ? '> Reference link' : firstBlock === 'code' ? '```text\nReference\n```' : 'Reference'
    const doc = `${prefix}\n\n${PARAGRAPH}\n\n${PARAGRAPH}\n\nClosing paragraph.`
    await page.setViewportSize({ width: 1200, height: 1100 })
    await mockLocalWorkspaceApi(page)
    await mockDesktopBridge(page, doc, {}, 'selection.md', {
      secureValues: {
        'kition.desktop.settings.v1': JSON.stringify({ general: { theme: 'dark' } }),
      },
    })
    await page.goto('/')
    await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.locator('.cm-line', { hasText: 'Closing paragraph.' })).toBeVisible()

    for (const backward of [false, true]) {
      await page.evaluate(({ paragraph, backward }) => {
        const content = document.querySelector('.cm-editor .cm-content') as any
        const view = content.cmTile.root.view
        const from = view.state.doc.toString().indexOf(paragraph)
        const to = view.state.doc.length
        view.focus()
        view.dispatch({ selection: backward ? { anchor: to, head: from } : { anchor: from, head: to } })
      }, { paragraph: PARAGRAPH, backward })

      // Check actual painted rectangles against every wrapped text fragment,
      // including the leftmost characters on the intermediate paragraphs.
      await expect.poll(() => page.evaluate(() => {
        const backgrounds = Array.from(document.querySelectorAll('.cm-selectionBackground'))
          .map((node) => node.getBoundingClientRect())
        const lines = Array.from(document.querySelectorAll('.cm-content .cm-line'))
          .filter((node) => node.textContent?.startsWith('Selected paragraph'))
        if (lines.length !== 2 || !backgrounds.length) return false
        return lines.every((line) => {
          const range = document.createRange()
          range.selectNodeContents(line)
          return Array.from(range.getClientRects()).filter((rect) => rect.width > 0).every((rect) => {
            const y = (rect.top + rect.bottom) / 2
            return backgrounds.some((background) => background.top <= y && background.bottom >= y
              && background.left <= rect.left + 1 && background.right >= rect.right - 1)
          })
        })
      })).toBe(true)
    }
    await page.screenshot({ path: test.info().outputPath('selection.png') })
  })
}
