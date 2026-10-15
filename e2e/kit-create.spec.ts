import { expect, test } from '@playwright/test'
import { kitEngine, openKitWorkspace } from './helpers/embeddedKit'

const photo = kitEngine('photo', 'kition_photo_sdk')

test('makes a new image with the engine in the Photo kit’s package and opens it in the kit’s editor', async ({ page, baseURL }, testInfo) => {
  test.skip(!photo.built, 'the Photo kit is not built into public/kits/photo-ui')
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    // The kits sit in their groups of the create menu.
    await expect(page.getByRole('group', { name: 'Creative' }).getByTestId('workspace-create-image')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Office' }).getByTestId('workspace-create-word')).toBeVisible()
    await page.locator('.document-create-menu--portal').screenshot({ path: testInfo.outputPath('create-menu.png') })
    await page.getByTestId('workspace-create-image').click()

    // The page made the file with the kit's engine and wrote it to the workspace…
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled image.psd'])
    expect(saves[0]!.bytes.subarray(0, 4).toString()).toBe('8BPS')
    // …then opened it in the kit's own editor, at the size the create menu asks for.
    await expect(page.getByTestId('kit-frame')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('photo-status')).toContainText('1920', { timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})
