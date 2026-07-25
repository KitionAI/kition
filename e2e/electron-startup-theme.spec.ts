import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('uses a dark native window before the renderer is shown', async () => {
  test.setTimeout(60_000)
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'kition-theme-e2e-'))

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      KITION_DESKTOP_SKIP_API: 'true',
    },
  })

  try {
    await app.firstWindow()
    const windowState = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win
        ? {
            backgroundColor: win.getBackgroundColor(),
            visible: win.isVisible(),
          }
        : null
    })

    expect(windowState).not.toBeNull()
    expect(windowState?.backgroundColor.toLowerCase()).toContain('#1b1e22')
    expect(windowState?.visible).toBe(true)
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
