import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { keepKitChannels, noteGesture as gesture, requestFromNote as fromKit } from './helpers/kitChannel'
import { openNote } from './helpers/noteKit'

/**
 * Kition serves a kit's `files/*` requests (KitFiles 1.0) over the workspace: the Note kit, whose
 * manifest may create exports (`files.create`) and reads no other file, asks over its own host
 * channel as its editor does. Handles and names reach the kit, never a workspace path; new files
 * land beside the note and never replace one; `files/pick` opens Kition's workspace picker.
 */
test.setTimeout(180_000)

test('Kition serves files/create and files/write beside the note, never replacing a file, and refuses what the manifest does not declare', async ({ page, baseURL }) => {
  await keepKitChannels(page)
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
  await keepKitChannels(page)
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

test('files/pick opens a workspace file or lists a folder for a kit whose manifest reads them', async ({ page, baseURL }) => {
  await keepKitChannels(page)
  // The note's manifest as a kit that reads text files and folders would declare it (K15).
  await page.route('**/kits/note-ui/kit.json', async (route) => {
    const manifest = await (await route.fetch()).json()
    await route.fulfill({ json: { ...manifest, files: { ...manifest.files, read: ['txt'], folders: true } } })
  })
  const others = { 'Data/a.txt': Buffer.from('alpha'), 'Data/b.txt': Buffer.from('beta'), 'Data/c.md': Buffer.from('# c'), '.kition/hidden.txt': Buffer.from('x') }
  const { kit } = await openNote(page, baseURL!, 'Plan.md', '# Plan\n\nGoals.\n', others)
  const picker = page.getByTestId('kit-file-picker')

  // Open: only the files the kit may read, never a hidden one; the kit reads the chosen one by its handle.
  await gesture(kit)
  const opening = fromKit(page, 'files/pick', { purpose: 'insert', mode: 'open', accept: ['txt'] })
  await expect(picker).toHaveAttribute('data-mode', 'open')
  await expect(picker.getByTestId('kit-file-picker-entry')).toHaveCount(2)
  await page.getByTestId('kit-file-picker-search').fill('b.txt')
  await picker.getByTestId('kit-file-picker-entry').click()
  await page.getByTestId('kit-file-picker-confirm').click()
  const opened = await opening
  expect(opened.result!.files).toEqual([expect.objectContaining({ name: 'b.txt', kind: 'file', rights: ['read'] })])
  expect(JSON.stringify(opened.result)).not.toContain('Data')
  const read = await fromKit(page, 'files/read', { handle: opened.result!.files[0].handle })
  expect(read.error).toBeUndefined()
  expect(read.result!.text).toBe('beta')

  // Folder: the kit lists the files in it it may read.
  await gesture(kit)
  const choosing = fromKit(page, 'files/pick', { purpose: 'import', mode: 'folder', accept: ['txt'] })
  await expect(picker).toHaveAttribute('data-mode', 'folder')
  await expect(picker.getByTestId('kit-file-picker-entry')).toHaveText(['Data'])
  await picker.getByTestId('kit-file-picker-entry').dblclick()
  const folder = await choosing
  expect(folder.result!.files).toEqual([expect.objectContaining({ name: 'Data', kind: 'folder' })])
  const listed = await fromKit(page, 'files/list', { handle: folder.result!.files[0].handle })
  expect(listed.result!.files.map((file: { name: string }) => file.name)).toEqual(['a.txt', 'b.txt'])

  // A type the manifest does not read is refused before any picker opens.
  await gesture(kit)
  expect((await fromKit(page, 'files/pick', { purpose: 'insert', mode: 'open', accept: ['md'] })).error?.data?.reason).toBe('not-allowed')
  await expect(picker).toHaveCount(0)
})
