import { expect, test } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const CJK_HEADING = String.fromCodePoint(0x6587, 0x6863, 0x7528, 0x9014)
const HEADING = `1.${CJK_HEADING}`
const FILLER = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}. ${'Long document content wraps across multiple lines. '.repeat(8)}`).join('\n\n')

test('a table of contents anchor locates the Unicode heading in editing and reading views', async ({ page }) => {
  const doc = `- [Open section](#${encodeURIComponent(`1-${CJK_HEADING}`)})\n\n${FILLER}\n\n## ${HEADING}\n\nTarget content\n\n${FILLER}`
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, doc, {}, 'anchor.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) await page.getByRole('button', { name: 'Reading view', exact: true }).click()
    const link = page.locator('.cm-md-link[data-href]', { hasText: 'Open section' }).first()
    await expect(link).toBeVisible()
    await link.click()
    await expect.poll(() => page.evaluate((heading) => {
      const content = document.querySelector('.cm-editor .cm-content') as any
      const view = content.cmTile.root.view
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      const target = Array.from(content.querySelectorAll('.cm-line') as NodeListOf<HTMLElement>)
        .find((node) => node.textContent?.includes(heading))
      if (!target || !line.text.includes(heading)) return false
      const top = target.getBoundingClientRect().top - view.scrollDOM.getBoundingClientRect().top
      return top >= 0 && top < 65
    }, HEADING)).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view.state.doc.toString())).toBe(doc)
    if (attempt === 1) await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    if (attempt === 0) {
      await page.locator('.cm-editor .cm-scroller').evaluate((element) => { element.scrollTop = 0 })
    }
  }
})
