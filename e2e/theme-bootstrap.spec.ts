import { expect, test } from '@playwright/test'

test('applies the dark background before the application module loads', async ({ page }) => {
  await page.route('**/src/main.tsx*', async (route) => {
    await route.abort()
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const root = page.locator('html')
  await expect(root).toHaveClass(/dark/)
  await expect(root).toHaveAttribute('data-desktop-theme-mode', 'dark')
  await expect(root).toHaveAttribute('data-desktop-theme', 'dark')

  const firstFrame = await root.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      colorScheme: style.colorScheme,
    }
  })
  expect(firstFrame.colorScheme).toBe('dark')
  expect(firstFrame.backgroundColor).not.toBe('rgb(255, 255, 255)')
  expect(firstFrame.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
})
