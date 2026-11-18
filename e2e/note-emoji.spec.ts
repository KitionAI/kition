import { expect, test } from '@playwright/test'

import { noteFrame, openNote, waitForNoteText } from './helpers/noteKit'

/**
 * Emoji draw in color in a note: the Note kit's engine shapes them in Noto Color Emoji and paints
 * its layers and gradients on the canvas, with a flag, a keycap, and a family as one glyph each.
 */
test.setTimeout(120_000)

test('draws emoji in color on the note canvas', async ({ page, baseURL }, testInfo) => {
  const emoji = '\u{1F680}\u{1F389}\u{1F600}\u{2705}\u{2764}\u{FE0F}\u{1F1E8}\u{1F1F3}1\u{FE0F}\u{20E3}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'
  const text = `# Plan ${emoji}\n\nA line with emoji ${emoji} and more text.\n`
  await openNote(page, baseURL!, 'Emoji.md', text)
  await waitForNoteText(page, text)
  const frame = await noteFrame(page)
  // Colored pixels: the note's text is near black on white, so only the emoji are colorful.
  const colored = () =>
    frame.evaluate(() => {
      const canvas = document.querySelector('[data-testid="note-canvas"] canvas') as HTMLCanvasElement | null
      const data = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let at = 0; data && at < data.length; at += 4) {
        if ((data[at + 3] ?? 0) > 200 && Math.abs((data[at] ?? 0) - (data[at + 2] ?? 0)) > 60) count += 1
      }
      return count
    })
  await expect.poll(colored, { timeout: 30_000 }).toBeGreaterThan(500)
  await page.screenshot({ path: testInfo.outputPath('emoji.png') })
})
