import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test'
import type { DesktopHost } from './desktopHost'
import { openInKitFrame, openKitWorkspace } from './embeddedKit'

const NOTE_UI = path.join(process.cwd(), 'public', 'kits', 'note-ui')

/** Whether the Note kit's pinned package is in `public/kits/note-ui` (`make kit-fetch`). */
export const noteKitPackaged = existsSync(path.join(NOTE_UI, 'kit-ui.json')) && existsSync(path.join(NOTE_UI, 'engine', 'kition_note_sdk_bg.wasm'))

/** Fails, never skips, without the Note kit's package: the specs that use it are gates. */
export function requireNoteKit() {
  expect(noteKitPackaged, 'public/kits/note-ui is missing: run make kit-fetch (or scripts/build-kit-ui.sh note)').toBe(true)
}

/**
 * Until the Note kit replaces Kition's native Markdown editor, a development build opens `.md`
 * files in it with this flag (`noteKitForDevelopment` in kitEditors.ts).
 */
async function openMarkdownInNoteKit(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('kition.dev.noteKit', '1'))
}

/**
 * Opens the note `name` (written to the workspace from `text`, beside `others`) in the Note kit's
 * editor in Kition, and waits for its text. Answers the kit's frame, the workspace host, and the
 * files Kition saved through its file API (with `persist`, also written to the workspace).
 */
export async function openNote(page: Page, baseURL: string, name: string, text: string, others: Record<string, Buffer> = {}, options: Parameters<typeof openKitWorkspace>[3] = {}) {
  requireNoteKit()
  await openMarkdownInNoteKit(page)
  const opened = await openInKitFrame(page, baseURL, name, Buffer.from(text), others, options)
  await expect(opened.kit.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  return opened
}

/** The Note kit's page in the frame of `name` (for `evaluate`). */
export async function noteFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined
  await expect.poll(() => (found = page.frames().find((frame) => frame.url().includes('/kits/note-ui/'))) !== undefined).toBe(true)
  return found!
}

/** The note's text as its editor holds it. */
export async function noteText(page: Page) {
  return (await noteFrame(page)).evaluate(() => {
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: { root: { view: { state: { doc: { toString(): string } } } } } }) | null
    return content?.cmTile?.root.view.state.doc.toString() ?? ''
  })
}

/** Presses `key` with the platform's command key, as the kit reads the platform (`navigator.platform`). */
export async function pressCommand(page: Page, kit: FrameLocator, key: string) {
  const mac = await kit.locator('body').evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+${key}`)
}

/** Another program changed `path` in the workspace, and the desktop shell's watcher says so. */
export async function changedOnDisk(host: DesktopHost, path: string) {
  await host.emit('desktop:document:external-change', { path, eventType: 'change', mtimeMs: Date.now() })
}

/** The lines `after` has that `before` lacks and the reverse (common prefix and suffix removed). */
export function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  return { removed: a.slice(start, endA), added: b.slice(start, endB) }
}
