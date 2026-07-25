import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('electron browser session attaches a real browser surface for generic-web', async () => {
  test.setTimeout(60_000)
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-browser-session-e2e-'))

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_DESKTOP_SKIP_API: 'true',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const ensureResult = await page.evaluate(async () => {
      const status = await window.kitionDesktop.EnsureBrowserSessionWindow({
        provider: 'generic-web',
        host: 'example.com',
        url: 'https://example.com',
      })
      return status
    })

    await page.waitForTimeout(1500)

    const mainInfo = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) {
        return { error: 'missing_window' }
      }
      const browserViews =
        typeof win.getBrowserViews === 'function' ? win.getBrowserViews() : []
      return {
        browserViewCount: browserViews.length,
        hasContentView: Boolean(win.contentView),
        bounds: win.getContentBounds(),
      }
    })

    expect(ensureResult.provider).toBe('generic-web')
    expect(ensureResult.window_open).toBe(true)
    expect(ensureResult.page_url || '').toContain('example.com')
    expect(mainInfo).toMatchObject({
      hasContentView: true,
    })
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
