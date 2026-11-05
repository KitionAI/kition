import { expect, test } from '@playwright/test'

// A new user follows the system (here light, then dark); a saved theme wins over the system.
for (const { name, system, saved, mode, theme } of [
  { name: 'the light system', system: 'light', saved: null, mode: 'auto', theme: 'light' },
  { name: 'the dark system', system: 'dark', saved: null, mode: 'auto', theme: 'dark' },
  { name: 'a saved dark theme', system: 'light', saved: 'dark', mode: 'dark', theme: 'dark' },
] as const) {
  test(`applies ${name}'s background before the application module loads`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: system })
    if (saved) {
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
    await expect(root).toHaveAttribute('data-desktop-theme-mode', mode)
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
