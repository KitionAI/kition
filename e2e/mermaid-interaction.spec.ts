import { expect, test } from '@playwright/test'
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const source = '# Diagrams\n\nBefore\n\n```mermaid\nflowchart TB\n  a[Client] --> b[Server]\n  b --> c[Storage]\n```\n\nAfter\n'

test.beforeEach(async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, source)
  await page.goto('/')
})

test('keeps the diagram when clicking either editor margin and reveals source only from its button', async ({ page }) => {
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  const diagram = editor.locator('.cm-md-mermaid-content svg')
  await expect(diagram).toBeVisible()
  const contentBox = (await editor.boundingBox())!
  const diagramBox = (await diagram.boundingBox())!
  for (const x of [contentBox.x - 15, contentBox.x + contentBox.width + 15]) {
    await page.mouse.click(x, diagramBox.y + diagramBox.height / 2)
    await expect(diagram).toBeVisible()
    await expect(editor).not.toContainText('flowchart TB')
  }
  await editor.locator('.cm-md-mermaid-content').click()
  await expect(diagram).toBeVisible()
  await editor.getByRole('button', { name: 'Edit source', exact: true }).click()
  await expect(diagram).toHaveCount(0)
  await expect(editor).toContainText('flowchart TB')
  await editor.locator('.cm-line', { hasText: /^After$/ }).click()
  await expect(diagram).toBeVisible()
  const saved = await page.evaluate(() => window.kitionDesktop!.ReadWorkspaceDocument!({ path: 'table-test.md' }))
  expect(saved.content).toBe(source)
})

test('opens an enlarged diagram on double-click, supports zoom and closes without revealing source', async ({ page }) => {
  const diagram = page.locator('.cm-md-mermaid-content')
  await expect(diagram.locator('svg')).toBeVisible()
  await diagram.dblclick()
  const preview = page.getByRole('dialog', { name: 'Mermaid diagram' })
  await expect(preview).toBeVisible()
  const svg = preview.locator('svg')
  await expect(svg).toBeVisible()
  const before = (await svg.boundingBox())!.width
  await preview.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => (await svg.boundingBox())!.width).toBeGreaterThan(before)
  await preview.getByRole('button', { name: 'Fit to window' }).click()
  await expect.poll(async () => Math.abs((await svg.boundingBox())!.width - before)).toBeLessThan(1)
  await page.screenshot({ path: '/tmp/kition-mermaid-preview.png' })
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(diagram.locator('svg')).toBeVisible()
  await expect(page.locator('.cm-content')).not.toContainText('flowchart TB')
  await diagram.focus()
  await page.keyboard.press('Enter')
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Close image preview' }).click()
  await expect(preview).toHaveCount(0)
})
