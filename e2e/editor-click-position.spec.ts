import { expect, test } from '@playwright/test'

import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

// Clicking into a live-preview line reveals its hidden Markdown markers.
// The caret must land on the character that was clicked, not wherever the
// reflowed text puts those screen coordinates afterwards.
const DOC = [
  '# Click target',
  '',
  '* Look closely at the content on that page',
  '*Is it missing any answers? Details? What would make it better?*',
  '* Check the phrases for which that page ranks',
  '*Do titles, headers and body text align with those phrases?*',
  'Look for other topically related pages',
  'Do we have anything that can link to this page?',
  '',
].join('\n')

test('clicking a word inside an italic line puts the caret on that word', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, DOC, {}, 'reference/overview.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })

  const line = page.locator('.cm-line', { hasText: 'Do titles, headers and' }).first()
  await expect(line).toBeVisible({ timeout: 20_000 })
  const box = await line.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent || '').indexOf(' and ')
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 2)
      range.setEnd(node, index + 3)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return null
  })
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x, box!.y)

  const caret = await page.evaluate(() => {
    // CodeMirror 6 keeps its view on the content element's tile root.
    const content = document.querySelector('.cm-editor .cm-content') as any
    const view = content?.cmTile?.root?.view
    if (!view) return null
    const { head, empty } = view.state.selection.main
    const line = view.state.doc.lineAt(head)
    return { empty, lineText: line.text, column: head - line.from }
  })
  expect(caret).not.toBeNull()
  expect(caret!.empty).toBe(true)
  expect(caret!.lineText).toBe('*Do titles, headers and body text align with those phrases?*')
  const expectedColumn = caret!.lineText.indexOf(' and ') + 2
  expect(Math.abs(caret!.column - expectedColumn)).toBeLessThanOrEqual(1)
})

test('double-clicking a word inside an italic line selects that word', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, DOC, {}, 'reference/overview.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })

  const line = page.locator('.cm-line', { hasText: 'Do titles, headers and' }).first()
  await expect(line).toBeVisible({ timeout: 20_000 })
  const point = await line.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent || '').indexOf(' and ')
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 2)
      range.setEnd(node, index + 3)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return null
  })
  expect(point).not.toBeNull()
  await page.mouse.dblclick(point!.x, point!.y)

  const selected = await page.evaluate(() => {
    const content = document.querySelector('.cm-editor .cm-content') as any
    const view = content?.cmTile?.root?.view
    if (!view) return null
    const { from, to } = view.state.selection.main
    return view.state.sliceDoc(from, to)
  })
  expect(selected).toBe('and')
})

// Standalone images are CodeMirror block widgets. If their box height differs
// from what CodeMirror measures (for example because of vertical margins),
// every line below is mapped too low and double-clicks select the word one
// line down. Images here load late, after the first measurement.
test('the editor height map stays aligned with the DOM below late-loading images', async ({ page }) => {
  const filler = (count: number) => Array.from({ length: count }, (_, index) => `Paragraph ${index + 1} with ordinary words in it.`).join('\n\n')
  const doc = [
    '# Images above the target', '', filler(6), '',
    '![image](../../attachments/first.png)', '', filler(4), '',
    '![image](../../attachments/second.png)', '', filler(3), '',
    '*Do titles, headers and body text align with those phrases?*',
    'Look for other topically related pages',
    '', filler(20), '',
  ].join('\n')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><rect width="900" height="520" fill="#888"/></svg>'
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/workspace-files/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg })
  })
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, doc, {}, 'reference/topic/overview.md')
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(() => Boolean((document.querySelector('.cm-editor .cm-content') as any)?.cmTile?.root?.view))

  const scrollToTarget = () => page.evaluate(() => {
    const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    const pos = view.state.doc.toString().indexOf('*Do titles')
    ;(view.scrollDOM as HTMLElement).scrollTop = Math.max(0, view.lineBlockAt(pos).top - 300)
  })
  await scrollToTarget()
  await page.waitForTimeout(1200)
  await scrollToTarget()
  const line = page.locator('.cm-line', { hasText: 'Do titles, headers and' }).first()
  await expect(line).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('.cm-md-image-block'))
    .every((wrap) => !wrap.classList.contains('is-loading')))).toBe(true)

  const lines = await page.evaluate(() => {
    const view = (document.querySelector('.cm-editor .cm-content') as any).cmTile.root.view
    const element = Array.from(document.querySelectorAll('.cm-line'))
      .find((candidate) => (candidate.textContent || '').includes('Do titles')) as HTMLElement
    const rect = element.getBoundingClientRect()
    const viaCoords = view.posAtCoords({ x: rect.left + 40, y: rect.top + rect.height / 2 })
    return {
      fromDom: view.state.doc.lineAt(view.posAtDOM(element, 0)).number,
      fromCoords: viaCoords == null ? null : view.state.doc.lineAt(viaCoords).number,
    }
  })
  expect(lines.fromCoords).toBe(lines.fromDom)
})
