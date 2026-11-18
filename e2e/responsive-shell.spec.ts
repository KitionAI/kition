import { expect, test, type Page } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { mockSuppressLauncher } from './helpers/mockSuppressLauncher'

async function bootShell(page: Page, viewport: { width: number; height: number }) {
  await mockSuppressLauncher(page, '/tmp/kition-responsive-vault')
  await mockLocalWorkspaceApi(page)
  await page.setViewportSize(viewport)
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 15_000 })
}

test.describe('responsive shell — narrow / tiny viewports', () => {
  test('desktop >=1024: full sidebar is visible and hamburger is hidden', async ({ page }) => {
    await bootShell(page, { width: 1280, height: 800 })
    await expect(page.locator('.app-shell.is-narrow')).toHaveCount(0)
    await expect(page.getByTestId('shell-sidebar-drawer-toggle')).toHaveCount(0)

    await expect(page.locator('.document-sidebar')).toBeVisible()
  })

  test('narrow <1024: sidebar is hidden and hamburger starts collapsed', async ({ page }) => {
    await bootShell(page, { width: 800, height: 800 })
    await expect(page.locator('.app-shell.is-narrow')).toHaveCount(1)
    const toggle = page.getByTestId('shell-sidebar-drawer-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const sidebar = page.locator('.document-sidebar').first()
    await expect(sidebar).toHaveCSS('transform', /matrix.*-?\d+/)
  })

  test('narrow <1024: hamburger toggles the drawer and backdrop or Escape closes it', async ({ page }) => {
    await bootShell(page, { width: 800, height: 800 })
    const toggle = page.getByTestId('shell-sidebar-drawer-toggle')
    const sidebar = page.locator('.document-sidebar').first()

    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(0)

    await toggle.click()
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(1)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const backdrop = page.getByTestId('shell-sidebar-drawer-backdrop')
    await expect(backdrop).toBeVisible()

    await page.waitForTimeout(260)
    const openTransform = await sidebar.evaluate((el) => getComputedStyle(el).transform)
    const settled =
      openTransform === 'none' || /matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)/.test(openTransform)
    expect(settled, `expected sidebar transform to be neutral, got ${openTransform}`).toBeTruthy()

    await backdrop.click()
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(0)

    await toggle.click()
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(0)
  })

  for (const width of [1024, 1100, 1200]) {
    test(`desktop ${width}: the sidebar header's files and collapse buttons are visible and not covered`, async ({ page }) => {
      await bootShell(page, { width, height: 768 })
      await expect(page.locator('.app-shell.is-narrow')).toHaveCount(0)
      const header = page.locator('.workspace-sidebar-header')
      const controls = [
        header.getByTestId('sidebar-tab-files'),
        header.locator('.workspace-sidebar-header-action'),
      ]
      for (const control of controls) {
        await expect(control).toBeVisible()
        const onTop = await control.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return hit !== null && element.contains(hit)
        })
        expect(onTop, `${await control.getAttribute('aria-label')} is covered by another element`).toBe(true)
      }
    })
  }

  test('tiny <480: viewport warning is visible', async ({ page }) => {
    await bootShell(page, { width: 390, height: 720 })
    await expect(page.locator('.app-shell.is-tiny')).toHaveCount(1)
    await expect(page.getByTestId('shell-tiny-viewport-hint')).toBeVisible()
  })

  test('resizing from narrow to desktop resets the drawer state', async ({ page }) => {
    await bootShell(page, { width: 800, height: 800 })
    await page.getByTestId('shell-sidebar-drawer-toggle').click()
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(1)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.locator('.app-shell.is-narrow')).toHaveCount(0)
    await expect(page.locator('.app-shell.is-sidebar-drawer-open')).toHaveCount(0)
  })
})
