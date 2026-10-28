import { expect, test } from '@playwright/test'
import { caretAfter, noteText, openNote, waitForNoteText } from '../helpers/noteKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Note kit (`kit.note`) in Kition on the desktop host: the host matrix, then the note's own
 * interactions. The count the matrix follows is the marks ` +1` in the note; a person adds one by
 * typing it after the first paragraph. Autosave is off (as in the other note specs), so unsaved
 * edits stay unsaved. The note's Markdown rendering, tables, history, and printing have their own
 * specs: e2e/note-*.spec.ts, e2e/kit-print.spec.ts.
 *
 * Rows not covered here: H8 (a damaged file): any bytes are Markdown text, so there is no damaged
 * note; H11 (printing) is e2e/kit-print.spec.ts; H13 (co-editing) is e2e/collab-note.spec.ts (`pnpm
 * test:collab:e2e`).
 */

const FIRST = 'Goals for the quarter.'
const note = (count = 0) => `# Plan\n\n${FIRST}\n\nClosing words.${' +1'.repeat(count)}\n`
const marks = (text: string) => (text.match(/ \+1/g) ?? []).length

hostMatrix({
  kit: 'note',
  prefix: 'note',
  name: 'Plan.md',
  title: 'Plan',
  fixture: async () => Buffer.from(note()),
  variant: async () => Buffer.from(note(2)),
  variantCount: 2,
  base: 0,
  prepare: (page) => page.addInitScript(() => window.localStorage.setItem('kit.note.autosave', 'off')),
  ready: (kit) => expect(kit.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 }),
  shown: async (_kit, page) => marks(await noteText(page)),
  saved: async (bytes) => marks(bytes.toString('utf8')),
  edit: async (kit, page) => {
    await caretAfter(page, kit, FIRST)
    await page.keyboard.type(' +1')
    await expect(kit.getByTestId('note-unsaved')).toBeVisible()
  },
  focus: (kit) => kit.getByTestId('note-canvas').click({ position: { x: 10, y: 10 } }),
  // The note merges the file changed on disk with the unsaved edits instead of loading it plainly.
  conflict: { bar: 'note-disk-changed', keep: 'note-disk-keep', reload: 'note-disk-merge' },
  afterReload: async (kit, page) => {
    await expect(kit.getByTestId('note-disk-changed')).toHaveCount(0)
    await expect.poll(() => noteText(page)).toContain('Closing words. +1 +1')
    await expect.poll(() => noteText(page)).toContain(`${FIRST} +1`)
  },
  create: { group: 'Documents', name: 'Untitled note.md', count: 0 },
  agent: { command: 'text.insert', params: { at: `# Plan\n\n${FIRST}`.length, text: ' +1' } },
})

test.describe('note details', () => {
  test.setTimeout(180_000)

  test('a list typed with Enter continues itself, and the saved Markdown is the typed list', tags('note', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openNote(page, baseURL!, 'Plan.md', '# Plan\n\n- Hire\n', {}, { persist: true })
    try {
      await caretAfter(page, kit, 'Hire')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Ship')
      await waitForNoteText(page, '- Hire\n- Ship')
      await saveNow(kit, 'note')
      expect((await onDisk(host, 'Plan.md')).toString('utf8')).toBe('# Plan\n\n- Hire\n- Ship\n')
    } finally {
      await host.dispose()
    }
  })
})
