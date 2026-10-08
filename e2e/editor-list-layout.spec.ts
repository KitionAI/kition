import { expect, test } from '@playwright/test'
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

test('keeps bullet spacing compact and wrapped list text aligned at every depth', async ({ page }) => {
  const longText = 'Long metadata entry with optional fields and additional details that should wrap while keeping its text aligned.'
  const source = `# Lists\n\n- ${longText}\n    -   Nested entry\n        -   ${longText}\n\n-   Extra spacing\n- [ ] Task\n1. Ordered entry\n`
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, source)
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor.locator('.cm-md-bullet')).toHaveCount(4)
  for (const dark of [false, true]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
    for (const width of [600, 320]) {
      await editor.evaluate((element, width) => { element.style.maxWidth = `${width}px` }, width)
      const rows = await editor.locator('.cm-md-bullet-line').evaluateAll((lines) => lines.map((line) => {
        const bullet = line.querySelector('.cm-md-bullet')!
        const marker = document.createRange()
        marker.selectNodeContents(bullet)
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        let text: Node | null
        while ((text = walker.nextNode())) {
          if (!bullet.contains(text) && /[A-Za-z]/.test(text.textContent || '')) break
        }
        const range = document.createRange()
        range.selectNodeContents(text!)
        const rects = Array.from(range.getClientRects()).map((rect) => ({ left: rect.left, top: rect.top }))
        return { gap: rects[0].left - marker.getBoundingClientRect().right, rects }
      }))
      for (const row of rows) {
        expect(row.gap).toBeGreaterThanOrEqual(3)
        expect(row.gap).toBeLessThanOrEqual(9)
        for (const rect of row.rects) expect(Math.abs(rect.left - row.rects[0].left)).toBeLessThan(1)
      }
      expect(rows[0].rects.length).toBeGreaterThan(1)
      expect(rows[2].rects.length).toBeGreaterThan(1)
      expect(rows[1].rects[0].left).toBeGreaterThan(rows[0].rects[0].left)
      expect(rows[2].rects[0].left).toBeGreaterThan(rows[1].rects[0].left)
    }
    await page.screenshot({ path: `/tmp/kition-list-layout-${dark ? 'dark' : 'light'}.png` })
  }
  await expect(editor.locator('.cm-md-task-checkbox')).toHaveCount(1)
  await expect(editor.locator('.cm-md-list-mark')).toHaveText('1.')
  const saved = await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' }))
  expect(saved?.content).toBe(source)
})
