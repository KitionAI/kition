import { expect, test } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'

/**
 * A new, empty workspace's first-run setup writes Getting Started, then reloads the file tree and
 * opens the activation dialog. Until it settles, the workspace shows loading instead of its tree
 * and its empty home, so the setup's reload and dialog never close a create menu the person had
 * just opened (CI: e2e/kit-create.spec.ts timed out on a create menu the reload took away).
 */
test('a new workspace offers its create menu only once its first-run setup has settled', async ({ page, baseURL }) => {
  // Getting Started's manifest waits until the test lets it go: the setup is under way until then.
  let releaseManifest = () => {}
  const manifestHeld = new Promise<void>((resolve) => { releaseManifest = resolve })
  let setupReachedManifest = () => {}
  const setupWaiting = new Promise<void>((resolve) => { setupReachedManifest = resolve })
  const { host } = await openKitWorkspace(page, baseURL!, {}, {
    routes: async (p) => {
      await p.route('**/onboarding/manifest.json', async (route) => {
        setupReachedManifest()
        await manifestHeld
        await route.fallback()
      })
    },
  })
  const activation = page.getByTestId('first-run-activation')
  // This test answers the dialog itself.
  await page.removeLocatorHandler(activation)
  const create = page.locator('.document-private-heading .document-create-menu-anchor > button')
  try {
    // The setup reads the workspace's files before Getting Started's manifest, so the tree has its
    // files by now; the workspace still shows loading, with no create menu and no empty home.
    await setupWaiting
    await expect(page.getByText('Loading local directory')).toBeVisible()
    await expect(create).toHaveCount(0)
    await expect(page.getByText('Turn ideas into organized work')).toHaveCount(0)

    releaseManifest()
    // The setup ends with the activation dialog open; the tree and its create menu come with it.
    await expect(activation).toBeVisible({ timeout: 30_000 })
    await expect(create).toBeVisible()
    await activation.getByRole('button', { name: 'Skip for now' }).click()
    await expect(activation).toHaveCount(0)

    // A menu opened now stays open: nothing of the setup is left to take it away.
    await create.click()
    const photo = page.getByRole('group', { name: 'Visual' }).getByTestId('workspace-create-photo')
    await expect(photo).toBeVisible()
    await expect(page.getByText('Loading local directory')).toHaveCount(0)
  } finally {
    releaseManifest()
    await host.dispose()
  }
})
