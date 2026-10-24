import { expect, test } from '@playwright/test'

import { openNote } from './helpers/noteKit'

// The command and search palettes (Mod+K, Mod+Shift+F) are covered by
// app-shell.spec.ts; this file covers the tab shortcut and its guards. The note's
// editor forwards Kition's shortcuts from inside its frame.

test('Cmd/Ctrl+W closes the active tab and ignores extra modifiers', async ({ page, baseURL }) => {
  const { kit } = await openNote(page, baseURL!, 'notes/hello.md', '# Hello\n\nBody text\n')
  const tabs = page.locator('.document-tab-list .document-tab')
  await expect(tabs).toHaveCount(1)

  await kit.locator('.cm-line', { hasText: 'Body text' }).click()
  await page.keyboard.press('Control+Shift+W')
  await expect(tabs).toHaveCount(1)
  await page.keyboard.press('Control+Alt+W')
  await expect(tabs).toHaveCount(1)

  await page.keyboard.press('Control+W')
  await expect(tabs).toHaveCount(0)
})
