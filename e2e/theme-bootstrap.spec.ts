import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`applies the ${theme === 'light' ? 'default light' : 'saved dark'} background before the application module loads`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    if (theme === 'dark') {
      await page.addInitScript(() => {
        localStorage.setItem('kition.desktop.theme.bootstrap.v1', 'dark')
      })
    }
    await page.route('**/src/main.tsx*', async (route) => {
      await route.abort()
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const root = page.locator('html')
    if (theme === 'dark') await expect(root).toHaveClass(/dark/)
    else await expect(root).not.toHaveClass(/dark/)
    await expect(root).toHaveAttribute('data-desktop-theme-mode', theme)
    await expect(root).toHaveAttribute('data-desktop-theme', theme)

    const firstFrame = await root.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        colorScheme: style.colorScheme,
      }
    })
    expect(firstFrame.colorScheme).toBe(theme)
    if (theme === 'dark') expect(firstFrame.backgroundColor).not.toBe('rgb(255, 255, 255)')
    else expect(firstFrame.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(firstFrame.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })
}
