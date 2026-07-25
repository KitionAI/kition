import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('desktop provider inputs keep native select-all and paste shortcuts', async ({ baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-shortcuts-'))
  const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL as string,
      KITION_DESKTOP_SKIP_API: 'true',
    },
  })

  try {
    const page = await app.firstWindow()
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/settings?section=providers', baseURL as string).toString(), {
      waitUntil: 'commit',
    })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)
    const providerInput = page.getByLabel('API key').first()
    await expect(providerInput).toBeVisible({ timeout: 30_000 })

    await providerInput.click()
    await providerInput.press(`${shortcutModifier}+A`)
    await providerInput.type('CMD-A-REPLACED')
    await expect(providerInput).toHaveValue('CMD-A-REPLACED')

    await app.evaluate(({ clipboard }, value) => {
      clipboard.writeText(value)
    }, 'PASTED-BY-CMD-V')

    await providerInput.click()
    await providerInput.press(`${shortcutModifier}+A`)
    await providerInput.press(`${shortcutModifier}+V`)
    await expect(providerInput).toHaveValue('PASTED-BY-CMD-V')
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
