import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mockDesktopBridge } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

const hawkHtml = readFileSync(new URL('../packages/document-editor/src/lib/fixtures/hawkClipboard.html', import.meta.url), 'utf8')
const hawkTableHtml = readFileSync(new URL('../packages/document-editor/src/lib/fixtures/hawkTable.html', import.meta.url), 'utf8')

test('retains pasted text and retries failed images locally without copying again', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\nKeep this text\n')
  await page.addInitScript(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => { throw new Error('Download unavailable') }
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<p>Remote caption</p><img src="https://example.invalid/image.png?accessToken=fictional">')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.locator('.cm-pending-image')).toBeVisible()
  await expect(editor).toContainText('Keep this text')
  await expect(editor).toContainText('Remote caption')
  await expect(editor.locator('.cm-md-image img, .cm-html-table-widget img')).toHaveCount(0)
  const saved = await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' }))
  expect(saved?.content).not.toContain('accessToken')
  await page.evaluate(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => ({ mime_type: 'image/png', base64_content: 'AQID' })
    window.kitionDesktop!.ImportWorkspaceFile = async () => ({ imported_path: 'attachments/retried.png' })
  })
  await editor.getByRole('button', { name: 'Retry image download' }).click()
  await expect(editor.locator('.cm-pending-image')).toHaveCount(0)
  await expect(editor.locator('.cm-md-image img')).toHaveAttribute('src', /workspace-files\/attachments\/retried\.png/)
  await expect.poll(async () => (await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' })))?.content)
    .toContain('attachments/retried.png')
})

test('saves an existing external image to attachments from its context menu', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Image\n\n![Diagram](https://example.invalid/diagram.png?accessToken=fictional)\n')
  await page.addInitScript(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => ({ mime_type: 'image/png', base64_content: 'AQID' })
    window.kitionDesktop!.ImportWorkspaceFile = async (request) => {
      if (request.folder !== 'attachments/table-test.md' || request.base64_content !== 'AQID') throw new Error('Invalid attachment import')
      return { imported_path: 'attachments/local-diagram.png' }
    }
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor')
  await editor.locator('.cm-md-image').dispatchEvent('contextmenu')
  await page.getByText('Save to local attachments', { exact: true }).click()
  await expect(editor.locator('.cm-md-image img')).toHaveAttribute('src', /workspace-files\/attachments\/local-diagram\.png/)
  await expect.poll(async () => (await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' })))?.content)
    .toContain('![Diagram](attachments/local-diagram.png)')
  const saved = await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' }))
  expect(saved?.content).not.toContain('accessToken')
})

test('pastes merged Hawk tables as visible tables and supports undo', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\nReady\n')
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.click()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await editor.evaluate((element, html) => {
    const data = new DataTransfer()
    data.setData('text/html', html)
    data.setData('text/plain', 'Project owners\nEngineering\tQuality\tProduct\tPMO')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, hawkTableHtml)
  const table = editor.locator('.cm-html-table-widget table')
  await expect(table).toBeVisible()
  await expect(table.locator('tr')).toHaveCount(4)
  await expect(table.locator('[rowspan="3"]')).toHaveText('@Coordinator')
  await expect(table.locator('[colspan="2"]')).toHaveText('Shared owner')
  await expect(editor).not.toContainText('<table')
  await table.getByText('@Coordinator').click()
  await expect(table).toBeVisible()
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: '/tmp/kition-merged-table-dark.png' })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await page.screenshot({ path: '/tmp/kition-merged-table-light.png' })
  await editor.press(`${modifier}+z`)
  await expect(table).toHaveCount(0)
  await expect(editor).toContainText('Ready')
})

test('renders previously saved table HTML without requiring another paste', async ({ page }) => {
  const rawTable = hawkTableHtml.slice(hawkTableHtml.indexOf('<table'))
  const source = `# Project owners\n\n${rawTable}\n\nAfter the table\n`
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, source)
  await page.goto('/')
  const editor = page.getByTestId('document-editor')
  await expect(editor.locator('.cm-html-table-widget table')).toBeVisible()
  await expect(editor).toContainText('After the table')
  await expect(editor).not.toContainText('data-hk-guid')
  const saved = await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' }))
  expect(saved?.content).toBe(source)
})

test('pastes Hawk headings, six-level lists and code without flattening the source structure', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\n')
  await page.addInitScript(() => {
    const state = window as typeof window & { kitionDesktop: Record<string, unknown> }
    state.kitionDesktop.ReadRemoteImage = async () => ({ mime_type: 'image/png', base64_content: 'AQID' })
    state.kitionDesktop.ImportWorkspaceFile = async () => ({ imported_path: 'attachments/diagram.png' })
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.click()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await editor.evaluate((element, html) => {
    const data = new DataTransfer()
    data.setData('text/html', html)
    data.setData('text/plain', 'Fallback without formatting')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, hawkHtml)
  const readSaved = () => page.evaluate(async () => (await window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' }))?.content || '')
  await expect.poll(readSaved).toContain('attachments/diagram.png')
  const saved = await readSaved()
  expect(saved).toContain('# Background')
  expect(saved).toContain('## Goals')
  expect(saved).toContain('### Blocks')
  expect(saved).not.toMatch(/^#{1,6}\s*$/m)
  expect(saved).toMatch(/1\.\s+Small storage\n2\.\s+Fast editing\n3\.\s+Streaming load/)
  expect(saved).toMatch(/^\s{16}-\s+12 u16$/m)
  expect(saved).toMatch(/^\s{24}-\s+Payload$/m)
  expect(saved).toContain('```typescript\ntype Path = number[];\n# [1,0]\ntype Point = {\n  path: Path,')
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowUp' : 'Control+Home')
  await expect(editor).toContainText('Background')
  await page.screenshot({ path: '/tmp/kition-hawk-paste.png' })
})

test('inspects raw formats, isolates HTML preview, exports and clears the capture', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\nReady\n')
  await page.addInitScript(() => {
    const state = window as typeof window & { kitionDesktop: Record<string, unknown>; clipboardExport?: string }
    state.kitionDesktop.SaveTextFile = async (_title: string, _filename: string, content: string) => {
      state.clipboardExport = content
      return 'kition-clipboard.json'
    }
  })
  await page.goto('/settings?section=developer')
  const inspector = page.getByTestId('clipboard-inspector')
  await expect(inspector).toBeVisible()
  const requests: string[] = []
  page.on('request', (request) => { if (request.url().includes('example.invalid')) requests.push(request.url()) })
  const html = '<h2>Clipboard heading</h2><p><strong>Bold</strong></p><script>parent.clipboardExecuted=true</script><img src="https://example.invalid/tracker.png">'
  await inspector.getByRole('textbox', { name: 'Paste here to inspect' }).evaluate((element, html) => {
    const data = new DataTransfer()
    data.setData('text/html', html)
    data.setData('text/plain', 'Clipboard heading\nBold')
    data.setData('application/x-example', '{"source":"test"}')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, html)
  await expect(inspector.getByRole('textbox', { name: 'Raw clipboard data' })).toHaveValue(html)
  await expect(inspector.getByRole('textbox', { name: 'Converted Markdown' })).toHaveValue(/## Clipboard heading\n\n\*\*Bold\*\*/)
  await inspector.getByRole('combobox').selectOption('application/x-example')
  await expect(inspector.getByRole('textbox', { name: 'Raw clipboard data' })).toHaveValue('{"source":"test"}')
  await inspector.getByRole('button', { name: 'HTML preview', exact: true }).click()
  await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading', { name: 'Clipboard heading' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).clipboardExecuted)).toBeUndefined()
  expect(requests).toEqual([])
  await inspector.getByRole('button', { name: 'Export JSON' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).clipboardExport)).toBeTruthy()
  const exported = JSON.parse(await page.evaluate(() => (window as unknown as Record<string, string>).clipboardExport))
  expect(exported.payloads['text/html']).toBe(html)
  await page.screenshot({ path: 'test-results/clipboard-inspector.png', fullPage: true })
  await inspector.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(inspector.getByRole('textbox', { name: 'Raw clipboard data' })).toHaveCount(0)
})

test('pastes HTML structure into the document instead of flattening it to text', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\nReady\n')
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<p><strong>Pasted emphasis</strong></p><table><tr><th>Name</th><th>Count</th></tr><tr><td>Sample</td><td>2</td></tr></table>')
    data.setData('text/plain', 'Pasted emphasis\nName\tCount\nSample\t2')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.cm-table-widget table')).toBeVisible()
  await expect(page.locator('.cm-table-widget table')).toContainText('Sample')
  await expect(editor).toContainText('Pasted emphasis')
  await editor.press(`${modifier}+z`)
  await expect(editor).not.toContainText('Pasted emphasis')
  await expect(editor).toContainText('Ready')
})

test('imports mixed clipboard images through the desktop bridge and preserves numbered lists', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\nReady\n')
  await page.addInitScript(() => {
    const state = window as typeof window & { kitionDesktop: Record<string, unknown>; downloadedImage?: string }
    state.kitionDesktop.ReadRemoteImage = async (url: string) => {
      state.downloadedImage = url
      return { mime_type: 'image/png', base64_content: 'AQID' }
    }
    state.kitionDesktop.ImportWorkspaceFile = async () => ({ imported_path: 'attachments/pasted-diagram.png' })
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await editor.click()
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<h2>Operator</h2><ol start="12"><li>u16</li><li>i16</li></ol><img src="https://example.invalid/protected.png" alt="Diagram">')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).downloadedImage))
    .toBe('https://example.invalid/protected.png')
  await expect(editor).toContainText('Operator')
  await expect(editor).toContainText('u16')
  await expect(page.getByTestId('document-editor').locator('img[alt="Diagram"]')).toHaveAttribute('src', /pasted-diagram\.png/)
  await editor.press(`${modifier}+z`)
  await expect(editor).not.toContainText('Operator')
  await expect(editor).toContainText('Ready')
})

test('recognizes Markdown source wrapped in HTML and renders its Mermaid and table', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\n')
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.click()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  const source = '# Service design\n\n## Overview\n\n```mermaid\nflowchart TB\n    a[Client] --> b[Server]\n    b --> c[Disk]\n```\n\n| Layer | State |\n| --- | --- |\n| Store | Durable |\n\nEnd of document\n'
  await editor.evaluate((element, source) => {
    const wrapper = document.createElement('div')
    for (const line of source.split('\n')) {
      const span = document.createElement('span')
      span.textContent = line
      wrapper.append(span, document.createElement('br'))
    }
    const data = new DataTransfer()
    data.setData('text/plain', source)
    data.setData('text/html', wrapper.outerHTML)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, source)
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await expect.poll(async () => (await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' })))?.content)
    .toContain(source)
  await expect(editor.locator('.cm-md-mermaid-content svg')).toBeVisible({ timeout: 15000 })
  await expect(editor.locator('table')).toContainText('Durable')
})

test('retries a failed image inside a pasted GFM table and resolves the local attachment', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Clipboard\n\n')
  await page.addInitScript(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => { throw new Error('403') }
  })
  await page.goto('/')
  const editor = page.getByTestId('document-editor').locator('.cm-content').first()
  await expect(editor).toBeVisible()
  await editor.click()
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control')
  await editor.press(modifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<table><tr><th>Preview</th></tr><tr><td><img src="https://example.invalid/image.png?accessToken=fictional"></td></tr></table>')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.locator('table .cm-pending-image')).toBeVisible()
  await page.evaluate(() => {
    window.kitionDesktop!.ReadRemoteImage = async () => ({ mime_type: 'image/png', base64_content: 'AQID' })
    window.kitionDesktop!.ImportWorkspaceFile = async () => ({ imported_path: 'attachments/table-image.png' })
  })
  await editor.getByRole('button', { name: 'Retry image download' }).click()
  await expect(editor.locator('table img')).toHaveAttribute('src', /workspace-files\/attachments\/table-image\.png/)
  await expect(editor.locator('.cm-pending-image')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(async () => window.kitionDesktop?.ReadWorkspaceDocument?.({ path: 'table-test.md' })))?.content)
    .toContain('attachments/table-image.png')
})
