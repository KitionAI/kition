import type { FrameLocator, Page } from '@playwright/test'

/**
 * The clips on the Film kit's V1 (upstream's `timeline.clip`). Matched by Kit UI id, since a
 * clip's thumbnail and waveform also carry `film-clip-*` test ids.
 */
export const filmClips = (kit: FrameLocator) => kit.getByTestId('film-track-Video 1').locator('[data-kit-ui-id="control:timeline.clip"]')

/** The Program monitor's Play-Stop Toggle (upstream `monitor.rs` `transport`). */
export const filmPlay = (kit: FrameLocator) => kit.getByTestId('film-program-transport-playback.toggle')

/**
 * Add Edit at the playhead (`sequence.addEdit`, Cmd+K on a Mac, Ctrl+K elsewhere); upstream's
 * monitors have no split button. The kit reads the platform from `navigator.platform` (kit-ui's
 * `isMac`), which the browser's device emulation may set apart from the machine running the test.
 */
export async function filmAddEdit(page: Page, kit: FrameLocator) {
  const app = kit.locator('.kui-app')
  const mac = await app.evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))
  await app.focus()
  await page.keyboard.press(mac ? 'Meta+k' : 'Control+k')
}
