import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openNote } from './helpers/noteKit'

/**
 * Kition serves a kit's `files/*` requests (KitFiles 1.0) over the workspace: the Note kit, whose
 * manifest may create exports (`files.create`) and reads no other file, asks over its own host
 * channel as its editor does. Handles and names reach the kit, never a workspace path; new files
 * land beside the note and never replace one; `files/pick` opens Kition's workspace picker.
 */
test.setTimeout(180_000)

type Answer = { result?: Record<string, any>; error?: { code: number; message: string; data?: { reason?: string } } }

/** Sends one `files/*` request from inside the note kit's frame over its host channel. */
async function fromKit(page: Page, method: string, params: Record<string, unknown>, bytes?: string): Promise<Answer> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/kits/note-ui/'))
  if (!frame) throw new Error('the note kit frame is not open')
  return frame.evaluate(
    async ({ method, params, bytes }) => {
      const port = (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort
      if (!port) throw new Error('the kit has no host channel')
      const id = `e2e-files-${Math.random().toString(36).slice(2)}`
      return new Promise<Answer>((resolve) => {
        const answer = (event: MessageEvent) => {
          if (event.data?.id !== id) return
          port.removeEventListener('message', answer)
          resolve(event.data)
        }
        port.addEventListener('message', answer)
        const body = bytes === undefined ? params : { ...params, bytes: new TextEncoder().encode(bytes).buffer }
        port.postMessage({ jsonrpc: '2.0', id, method, params: body })
      })
    },
    { method, params, bytes },
  )
}

/** A person's gesture in the kit, which `files/create` and `files/pick` need (FA6, FA11). */
const gesture = (kit: FrameLocator) => kit.getByTestId('note-title').click()

test('Kition serves files/create and files/write beside the note, never replacing a file, and refuses what the manifest does not declare', async ({ page, baseURL }) => {
  // Every frame keeps the host channel it is handed, so the test can speak for the kit.
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if ((event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 && event.ports[0]) (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort = event.ports[0]
    })
  })
  const { kit, host } = await openNote(page, baseURL!, 'Notes/Roadmap.md', '# Roadmap\n\nGoals.\n', { 'Notes/Report.html': Buffer.from('<p>old</p>') })

  await gesture(kit)
  const created = await fromKit(page, 'files/create', { suggestedName: 'Report.html', mime: 'text/html' })
  expect(created.error).toBeUndefined()
  // An existing export keeps its name: the new one gets the next free one, beside the note.
  expect(created.result).toMatchObject({ name: 'Report 2.html', kind: 'file', version: null })
  expect(created.result!.handle).toMatch(/^fh_/)
  expect(JSON.stringify(created.result)).not.toContain('Notes/')

  const written = await fromKit(page, 'files/write', { handle: created.result!.handle, offset: 0, final: true }, '<p>new</p>')
  expect(written.error).toBeUndefined()
  expect(await fs.readFile(path.join(host.root, 'Notes', 'Report 2.html'), 'utf8')).toBe('<p>new</p>')
  expect(await fs.readFile(path.join(host.root, 'Notes', 'Report.html'), 'utf8')).toBe('<p>old</p>')

  // A committed create is done: it never writes again.
  const again = await fromKit(page, 'files/write', { handle: created.result!.handle, offset: 0, final: true }, '<p>again</p>')
  expect(again.error?.data?.reason).toBe('already-committed')

  // The note's manifest creates no programs and reads no files.
  await gesture(kit)
  expect((await fromKit(page, 'files/create', { suggestedName: 'run.exe' })).error?.data?.reason).toBe('not-allowed')
  await gesture(kit)
  expect((await fromKit(page, 'files/pick', { purpose: 'insert', mode: 'open', accept: ['md'] })).error?.data?.reason).toBe('not-allowed')
  await expect(page.getByTestId('kit-file-picker')).toHaveCount(0)
  // A handle Kition never granted is refused.
  expect((await fromKit(page, 'files/write', { handle: 'fh_0000', offset: 0, final: true }, 'x')).error?.data?.reason).toBe('file-not-granted')
})

test('files/pick opens the workspace picker: save into a chosen folder, a replacement warned of, and a cancel that grants nothing', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if ((event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 && event.ports[0]) (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort = event.ports[0]
    })
  })
  const { kit, host } = await openNote(page, baseURL!, 'Plan.md', '# Plan\n\nGoals.\n', { 'Exports/Old.pdf': Buffer.from('%PDF-old'), '.kition/secret.pdf': Buffer.from('x') })

  // Save mode: the person names the file and chooses its folder; the kit gets a handle and a name.
  await gesture(kit)
  const saving = fromKit(page, 'files/pick', { purpose: 'export', mode: 'save', accept: ['pdf'], suggestedName: 'Plan.pdf' })
  const picker = page.getByTestId('kit-file-picker')
  await expect(picker).toHaveAttribute('data-mode', 'save')
  await expect(page.getByTestId('kit-file-picker-name')).toHaveValue('Plan.pdf')
  // Only the workspace's own folders, never a hidden one.
  await expect(picker.getByTestId('kit-file-picker-entry')).toHaveText(['Exports'])
  await picker.getByTestId('kit-file-picker-entry').click()
  await page.getByTestId('kit-file-picker-confirm').click()
  const saved = await saving
  expect(saved.error).toBeUndefined()
  expect(saved.result!.files).toHaveLength(1)
  expect(saved.result!.files[0]).toMatchObject({ name: 'Plan.pdf', kind: 'file', rights: ['create'] })
  expect(JSON.stringify(saved.result)).not.toContain('Exports')
  expect((await fromKit(page, 'files/write', { handle: saved.result!.files[0].handle, offset: 0, final: true }, '%PDF-new')).error).toBeUndefined()
  expect(await fs.readFile(path.join(host.root, 'Exports', 'Plan.pdf'), 'utf8')).toBe('%PDF-new')

  // A name already in the folder: the picker says it replaces the file, and the kit gets a write right.
  await gesture(kit)
  const replacing = fromKit(page, 'files/pick', { purpose: 'export', mode: 'save', accept: ['pdf'], suggestedName: 'Old.pdf' })
  await picker.getByTestId('kit-file-picker-entry').click()
  await expect(page.getByTestId('kit-file-picker-replaces')).toContainText('Old.pdf')
  await page.getByTestId('kit-file-picker-confirm').click()
  const replaced = await replacing
  expect(replaced.result!.files[0]).toMatchObject({ name: 'Old.pdf', rights: ['write'] })
  const version = replaced.result!.files[0].version as string
  expect((await fromKit(page, 'files/write', { handle: replaced.result!.files[0].handle, offset: 0, final: true, expected: version }, '%PDF-replaced')).error).toBeUndefined()
  expect(await fs.readFile(path.join(host.root, 'Exports', 'Old.pdf'), 'utf8')).toBe('%PDF-replaced')

  // A cancelled picker grants nothing.
  await gesture(kit)
  const cancelling = fromKit(page, 'files/pick', { purpose: 'export', mode: 'save', accept: ['pdf'], suggestedName: 'Never.pdf' })
  await page.getByTestId('kit-file-picker-cancel').click()
  expect((await cancelling).result).toEqual({ files: [] })
  await expect(picker).toHaveCount(0)
  expect(existsSync(path.join(host.root, 'Never.pdf'))).toBe(false)
})
