import { beforeEach, describe, expect, it, vi } from 'vitest'
import { person, Replica } from '@/lib/kdm'
import * as desktop from '@/services/desktop'
import { DOCUMENT_BODY } from './documentSchema'
import { documentBody } from './documentText'
import {
  childFolderPath,
  duplicateDocumentIdentity,
  forgetDocument,
  forgetDocumentFolder,
  hashFileText,
  mergeFileIntoReplica,
  noteWorkspaceFiles,
  openDocument,
  pruneDocumentStore,
  pruneDocumentStoreOnOpen,
  renameDocument,
  renameDocumentFolder,
  saveDocument,
  versionHex,
  type OpenedDocument,
} from './documentStore'

// The real browser-preview backends (workspace files and the replica store in localStorage), with spies that tests
// use to inject failures and conflicts.
vi.mock('@/services/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/desktop')>()
  return {
    ...actual,
    readDocumentStore: vi.fn(actual.readDocumentStore),
    writeDocumentStore: vi.fn(actual.writeDocumentStore),
    deleteDocumentStore: vi.fn(actual.deleteDocumentStore),
    readDocumentIndex: vi.fn(actual.readDocumentIndex),
    writeDocumentIndex: vi.fn(actual.writeDocumentIndex),
    listWorkspaceDocuments: vi.fn(actual.listWorkspaceDocuments),
    writeWorkspaceDocument: vi.fn(actual.writeWorkspaceDocument),
  }
})

const ROOT = 'browser-local-workspace'
const BOM = String.fromCodePoint(0xfeff)
const me = person('me')

const index = async () => (await desktop.readDocumentIndex()).entries
const fileText = async (path: string) => (await desktop.readWorkspaceDocument(path)).content
const writeFile = (path: string, text: string) => desktop.writeWorkspaceDocument(path, text)

async function open(path: string, actor = 1n) {
  return openDocument(path, await fileText(path), actor, { expectedRoot: ROOT })
}

function type(opened: Pick<OpenedDocument, 'replica' | 'rootId'>, at: number, text: string) {
  opened.replica.transact(me, (tx) => tx.textInsert(opened.rootId, DOCUMENT_BODY, at, text))
}

async function save(path: string, opened: OpenedDocument, onStoreError?: (error: unknown) => void) {
  return saveDocument({ path, opened, expectedFileText: opened.fileText, expectedRoot: ROOT, onStoreError })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  noteWorkspaceFiles(ROOT, null)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('hashing and paths', () => {
  it('hashes the UTF-8 bytes of the file text with SHA-256', async () => {
    expect(await hashFileText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await hashFileText('a\r\nb')).not.toBe(await hashFileText('a\nb'))
  })

  it('finds the child page folder of a file', () => {
    expect(childFolderPath('Notes/Plan.md')).toBe('Notes/Plan')
    expect(childFolderPath('Plan.md')).toBe('Plan')
    expect(childFolderPath('Notes/.hidden')).toBe('Notes/.hidden')
  })
})

describe('openDocument', () => {
  it('imports a file opened for the first time and records it', async () => {
    await writeFile('Notes/Plan.md', '# Plan\n\nText\n')
    const opened = await open('Notes/Plan.md')

    expect(opened.isNew).toBe(true)
    expect(opened.merged).toBe(false)
    expect(documentBody(opened.replica, opened.rootId)).toBe('# Plan\n\nText\n')
    expect(opened.fileText).toBe('# Plan\n\nText\n')
    expect(opened.meta).toMatchObject({ docId: opened.replica.docId, kit: 'kit.document', path: 'Notes/Plan.md', fileHash: await hashFileText('# Plan\n\nText\n'), exported: versionHex(opened.replica) })
    expect(await index()).toEqual({ 'Notes/Plan.md': opened.replica.docId })
    const stored = await desktop.readDocumentStore(opened.replica.docId)
    expect(stored?.meta).toEqual(opened.meta)
    expect(opened.replica.canUndo()).toBe(false)
  })

  it('reopens the stored replica with its saved edits', async () => {
    await writeFile('Plan.md', 'one\n')
    const first = await open('Plan.md')
    type(first, 4, 'two\n')
    const saved = await save('Plan.md', first)
    expect(saved.fileText).toBe('one\ntwo\n')
    expect(await fileText('Plan.md')).toBe('one\ntwo\n')

    const again = await open('Plan.md', 2n)
    expect(again.isNew).toBe(false)
    expect(again.merged).toBe(false)
    expect(again.replica.docId).toBe(first.replica.docId)
    expect(documentBody(again.replica, again.rootId)).toBe('one\ntwo\n')
    expect(again.meta).toEqual(saved.meta)
  })

  it('merges a file changed since the last save as an import', async () => {
    await writeFile('Plan.md', 'one\ntwo\n')
    const first = await open('Plan.md')
    await writeFile('Plan.md', 'one\n2\nthree\n')

    const again = await open('Plan.md', 2n)
    expect(again.isNew).toBe(false)
    expect(again.merged).toBe(true)
    expect(again.previousText).toBe('one\ntwo\n')
    expect(again.replica.docId).toBe(first.replica.docId)
    expect(documentBody(again.replica, again.rootId)).toBe('one\n2\nthree\n')
    expect(again.replica.canUndo()).toBe(false)
    // The merge is stored, so the next open has nothing to merge.
    expect(again.meta.fileHash).toBe(await hashFileText('one\n2\nthree\n'))
    const third = await open('Plan.md', 3n)
    expect(third.merged).toBe(false)
    expect(third.previousText).toBeUndefined()
  })

  it('records a change of line endings alone without merging text', async () => {
    await writeFile('Plan.md', 'one\ntwo\n')
    await open('Plan.md')
    await writeFile('Plan.md', 'one\r\ntwo\r\n')
    const again = await open('Plan.md', 2n)
    expect(again.merged).toBe(false)
    expect(again.style.eol).toBe('\r\n')
    expect(again.meta.fileHash).toBe(await hashFileText('one\r\ntwo\r\n'))
  })

  it('round-trips CRLF line endings and a byte order mark through save and open', async () => {
    const raw = `${BOM}# Title\r\n\r\nBody\r\n`
    await writeFile('Windows.md', raw)
    const first = await open('Windows.md')
    expect(documentBody(first.replica, first.rootId)).toBe('# Title\n\nBody\n')
    expect(first.style).toMatchObject({ eol: '\r\n', bom: true, finalNewline: true })

    type(first, '# Title\n\nBody\n'.length, 'More\n')
    const saved = await save('Windows.md', first)
    expect(saved.fileText).toBe(`${BOM}# Title\r\n\r\nBody\r\nMore\r\n`)
    expect(await fileText('Windows.md')).toBe(saved.fileText)
    expect(saved.meta.style).toMatchObject({ eol: '\r\n', bom: true })

    const again = await open('Windows.md', 2n)
    expect(again.merged).toBe(false)
    expect(again.isNew).toBe(false)
    expect(documentBody(again.replica, again.rootId)).toBe('# Title\n\nBody\nMore\n')
    expect(again.style).toEqual(first.style)
  })

  it('imports a new document when the stored snapshot is damaged, without touching the file', async () => {
    await writeFile('Plan.md', 'text\n')
    const first = await open('Plan.md')
    await desktop.writeDocumentStore(first.replica.docId, { meta: first.meta, snapshot: new Uint8Array([1, 2, 3]) })

    const again = await open('Plan.md', 2n)
    expect(again.isNew).toBe(true)
    expect(again.replica.docId).not.toBe(first.replica.docId)
    expect(documentBody(again.replica, again.rootId)).toBe('text\n')
    expect(await index()).toEqual({ 'Plan.md': again.replica.docId })
    expect(await desktop.readDocumentStore(first.replica.docId)).toBeNull()
    expect(await fileText('Plan.md')).toBe('text\n')
  })

  it('imports when the index names a document that has no store entry', async () => {
    await writeFile('Plan.md', 'text\n')
    const first = await open('Plan.md')
    await desktop.deleteDocumentStore(first.replica.docId)
    const again = await open('Plan.md', 2n)
    expect(again.isNew).toBe(true)
    expect(await index()).toEqual({ 'Plan.md': again.replica.docId })
  })

  it('imports when the store entry belongs to another document or cannot be read', async () => {
    await writeFile('A.md', 'a\n')
    await writeFile('B.md', 'b\n')
    const a = await open('A.md')
    const b = await open('B.md')
    // An entry whose snapshot is another document's.
    await desktop.writeDocumentStore(a.replica.docId, { meta: a.meta, snapshot: b.replica.snapshot() })
    expect((await open('A.md', 2n)).isNew).toBe(true)

    vi.mocked(desktop.readDocumentStore).mockRejectedValueOnce(new Error('disk on fire'))
    const reopened = await open('B.md', 3n)
    expect(reopened.isNew).toBe(true)
    expect(documentBody(reopened.replica, reopened.rootId)).toBe('b\n')
  })

  it('still opens when the store cannot be written or the index cannot be read', async () => {
    await writeFile('Plan.md', 'text\n')
    vi.mocked(desktop.writeDocumentStore).mockRejectedValueOnce(new Error('read-only'))
    const opened = await open('Plan.md')
    expect(opened.isNew).toBe(true)
    expect(documentBody(opened.replica, opened.rootId)).toBe('text\n')

    vi.mocked(desktop.readDocumentIndex).mockRejectedValueOnce(new Error('unreadable'))
    expect((await open('Plan.md', 2n)).isNew).toBe(true)
  })

  it('refuses to open for a workspace that is no longer the open one', async () => {
    await writeFile('Plan.md', 'text\n')
    await expect(openDocument('Plan.md', 'text\n', 1n, { expectedRoot: '/elsewhere' })).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
  })

  it('recognises a file renamed outside Kition by its hash and rebinds its entry', async () => {
    await writeFile('Old.md', 'same text\n')
    const first = await open('Old.md')
    await desktop.moveWorkspaceDocument({ path: 'Old.md', target_folder: 'Moved', target_name: 'New.md' })

    const again = await open('Moved/New.md', 2n)
    expect(again.isNew).toBe(false)
    expect(again.replica.docId).toBe(first.replica.docId)
    expect(again.meta.path).toBe('Moved/New.md')
    expect(await index()).toEqual({ 'Moved/New.md': first.replica.docId })
  })

  it('compares the stored file hash before loading a snapshot', async () => {
    await writeFile('Old.md', 'old text\n')
    await open('Old.md')
    await desktop.deleteWorkspaceDocument('Old.md')
    await writeFile('New.md', 'other text\n')
    const load = vi.spyOn(Replica, 'load')
    expect((await open('New.md', 2n)).isNew).toBe(true)
    expect(load).not.toHaveBeenCalled()
  })

  it('uses the workspace files the app knows instead of listing the workspace on every open', async () => {
    await writeFile('A.md', 'a\n')
    await open('A.md')
    await writeFile('B.md', 'b\n')
    noteWorkspaceFiles(ROOT, (await desktop.listWorkspaceDocuments()).items)
    vi.mocked(desktop.listWorkspaceDocuments).mockClear()
    expect((await open('B.md', 2n)).isNew).toBe(true)
    expect(desktop.listWorkspaceDocuments).not.toHaveBeenCalled()
  })

  it('checks the workspace again before taking an identity the known files suggest', async () => {
    await writeFile('Source.md', 'shared\n')
    const source = await open('Source.md')
    // The known files are stale: they do not show Source.md, which still exists.
    noteWorkspaceFiles(ROOT, [{ type: 'file', path: 'Other.md', name: 'Other.md', format: 'markdown' }] as never)
    await writeFile('Copy.md', 'shared\n')
    const copy = await open('Copy.md', 2n)
    expect(copy.isNew).toBe(true)
    expect(copy.replica.docId).not.toBe(source.replica.docId)
    expect((await index())['Source.md']).toBe(source.replica.docId)
  })

  it('does not take the identity of a file that still exists or whose text differs', async () => {
    await writeFile('Source.md', 'shared\n')
    const source = await open('Source.md')
    // A copy made outside Kition: same text, but the source is still there.
    await writeFile('Copy.md', 'shared\n')
    const copy = await open('Copy.md', 2n)
    expect(copy.isNew).toBe(true)
    expect(copy.replica.docId).not.toBe(source.replica.docId)

    // A renamed file that was also edited is a new document.
    await desktop.moveWorkspaceDocument({ path: 'Source.md', target_name: 'Renamed.md' })
    await writeFile('Renamed.md', 'shared and edited\n')
    expect((await open('Renamed.md', 3n)).isNew).toBe(true)
  })
})

describe('saveDocument', () => {
  it('passes the guard conflict through and leaves the store alone', async () => {
    await writeFile('Plan.md', 'one\n')
    const opened = await open('Plan.md')
    await writeFile('Plan.md', 'changed elsewhere\n')
    type(opened, 0, 'x')
    vi.mocked(desktop.writeDocumentStore).mockClear()

    await expect(save('Plan.md', opened)).rejects.toThrow('DESIGN_SAVE_CONFLICT')
    expect(desktop.writeDocumentStore).not.toHaveBeenCalled()
    expect(await fileText('Plan.md')).toBe('changed elsewhere\n')
  })

  it('reports a store failure after the file was written and does not throw', async () => {
    await writeFile('Plan.md', 'one\n')
    const opened = await open('Plan.md')
    type(opened, 0, 'zero\n')
    vi.mocked(desktop.writeDocumentStore).mockRejectedValueOnce(new Error('disk full'))
    const onStoreError = vi.fn()

    const saved = await save('Plan.md', opened, onStoreError)
    expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
    expect(saved.fileText).toBe('zero\none\n')
    expect(await fileText('Plan.md')).toBe('zero\none\n')
  })

  it('stores exactly the replica it wrote, not edits made while the file was written', async () => {
    await writeFile('Plan.md', 'one\n')
    const opened = await open('Plan.md')
    type(opened, 4, 'two\n')
    const written = versionHex(opened.replica)
    const actual = vi.mocked(desktop.writeWorkspaceDocument).getMockImplementation()!
    vi.mocked(desktop.writeWorkspaceDocument).mockImplementationOnce(async (...args) => {
      type(opened, 0, 'typed meanwhile ')
      return actual(...args)
    })

    const saved = await save('Plan.md', opened)
    expect(saved.fileText).toBe('one\ntwo\n')
    expect(saved.meta.exported).toBe(written)
    // The typing was never saved (the session discards it): reopening shows the file, not the typing.
    const again = await open('Plan.md', 2n)
    expect(again.merged).toBe(false)
    expect(documentBody(again.replica, again.rootId)).toBe('one\ntwo\n')
  })

  it('writes the new path, hash, and exported version into the meta', async () => {
    await writeFile('Plan.md', 'one\n')
    const opened = await open('Plan.md')
    type(opened, 0, 'a')
    const saved = await save('Plan.md', opened)
    expect(saved.meta).toMatchObject({ docId: opened.replica.docId, path: 'Plan.md', fileHash: await hashFileText('aone\n'), exported: versionHex(opened.replica) })
    expect((await desktop.readDocumentStore(opened.replica.docId))?.meta).toEqual(saved.meta)
  })
})

describe('mergeFileIntoReplica', () => {
  it('merges an external change with local edits as an import', async () => {
    await writeFile('Plan.md', 'one\ntwo\nthree\n')
    const opened = await open('Plan.md')
    type(opened, 0, 'zero\n')
    const undoable = opened.replica.canUndo()

    expect(mergeFileIntoReplica(opened, opened.fileText, 'one\ntwo\nthree\nfour\n')).toBe('merged')
    expect(documentBody(opened.replica, opened.rootId)).toBe('zero\none\ntwo\nthree\nfour\n')
    expect(opened.replica.canUndo()).toBe(undoable)
    opened.replica.undo()
    expect(documentBody(opened.replica, opened.rootId)).toBe('one\ntwo\nthree\nfour\n')
  })

  it('answers unchanged for the same text in another line style', async () => {
    await writeFile('Plan.md', 'one\n')
    const opened = await open('Plan.md')
    const before = versionHex(opened.replica)
    expect(mergeFileIntoReplica(opened, 'one\n', `${BOM}one\r\n`)).toBe('unchanged')
    expect(versionHex(opened.replica)).toBe(before)
  })
})

describe('identity across tree operations', () => {
  async function seed(paths: string[]) {
    const ids: Record<string, string> = {}
    for (const path of paths) {
      await writeFile(path, `${path}\n`)
      ids[path] = (await open(path)).replica.docId
    }
    return ids
  }

  it('keeps the document id of a renamed file and of its child pages', async () => {
    const ids = await seed(['A/Page.md', 'A/Page/Child.md', 'A/Page/Deep/Leaf.md', 'A/Pages.md', 'A/Other.md'])
    await renameDocument('A/Page.md', 'B/Renamed.md')
    expect(await index()).toEqual({
      'B/Renamed.md': ids['A/Page.md'],
      'B/Renamed/Child.md': ids['A/Page/Child.md'],
      'B/Renamed/Deep/Leaf.md': ids['A/Page/Deep/Leaf.md'],
      'A/Pages.md': ids['A/Pages.md'],
      'A/Other.md': ids['A/Other.md'],
    })
  })

  it('reopens a renamed document with its identity and history', async () => {
    await writeFile('Plan.md', 'one\n')
    const first = await open('Plan.md')
    type(first, 0, 'zero\n')
    await save('Plan.md', first)
    await desktop.moveWorkspaceDocument({ path: 'Plan.md', target_name: 'Renamed.md' })
    await renameDocument('Plan.md', 'Renamed.md')

    const again = await open('Renamed.md', 2n)
    expect(again.isNew).toBe(false)
    expect(again.replica.docId).toBe(first.replica.docId)
    expect(documentBody(again.replica, again.rootId)).toBe('zero\none\n')
  })

  it('keeps the document ids of nested documents when a folder is renamed', async () => {
    const ids = await seed(['Team/Notes.md', 'Team/Sub/Deep.md', 'Teamwork/Keep.md', 'Top.md'])
    await renameDocumentFolder('Team', 'Archive/Group')
    expect(await index()).toEqual({
      'Archive/Group/Notes.md': ids['Team/Notes.md'],
      'Archive/Group/Sub/Deep.md': ids['Team/Sub/Deep.md'],
      'Teamwork/Keep.md': ids['Teamwork/Keep.md'],
      'Top.md': ids['Top.md'],
    })
  })

  /** The index entries on workspace paths (without the deleted documents kept until the next prune). */
  const livePaths = async () => Object.fromEntries(Object.entries(await index()).filter(([path]) => !path.startsWith('.kition/')))

  it('forgets a deleted file and its child pages, keeping their replicas until the next prune', async () => {
    const ids = await seed(['Page.md', 'Page/Child.md', 'Pages.md'])
    await forgetDocument('Page.md')
    expect(await livePaths()).toEqual({ 'Pages.md': ids['Pages.md'] })
    expect(await desktop.readDocumentStore(ids['Page.md'])).not.toBeNull()
    expect(await desktop.readDocumentStore(ids['Page/Child.md'])).not.toBeNull()

    // Deleting a page deletes its child pages with it.
    await desktop.deleteWorkspaceDocument('Page.md')
    await desktop.deleteWorkspaceDocument('Page/Child.md').catch(() => undefined)
    await pruneDocumentStore({ expectedRoot: ROOT })
    expect(await index()).toEqual({ 'Pages.md': ids['Pages.md'] })
    expect(await desktop.readDocumentStore(ids['Page.md'])).toBeNull()
    expect(await desktop.readDocumentStore(ids['Page/Child.md'])).toBeNull()
    expect(await desktop.readDocumentStore(ids['Pages.md'])).not.toBeNull()
  })

  it('forgets the documents of a deleted folder', async () => {
    const ids = await seed(['Team/Notes.md', 'Team/Sub/Deep.md', 'Teamwork/Keep.md'])
    await forgetDocumentFolder('Team')
    expect(await livePaths()).toEqual({ 'Teamwork/Keep.md': ids['Teamwork/Keep.md'] })
    expect(await desktop.readDocumentStore(ids['Team/Notes.md'])).not.toBeNull()
  })

  it('gives a deleted document its identity back when its file is restored', async () => {
    const ids = await seed(['Plan.md'])
    const text = await fileText('Plan.md')
    await desktop.deleteWorkspaceDocument('Plan.md')
    await forgetDocument('Plan.md')
    await writeFile('Plan.md', text)
    const restored = await open('Plan.md', 2n)
    expect(restored.isNew).toBe(false)
    expect(restored.replica.docId).toBe(ids['Plan.md'])
    expect(await index()).toEqual({ 'Plan.md': ids['Plan.md'] })
  })

  it('keeps an entry whose file went away outside Kition for one more workspace open, then drops it', async () => {
    const ids = await seed(['Gone.md', 'Kept.md'])
    await desktop.deleteWorkspaceDocument('Gone.md')
    await pruneDocumentStore({ expectedRoot: ROOT })
    expect(await livePaths()).toEqual({ 'Kept.md': ids['Kept.md'] })
    expect(await desktop.readDocumentStore(ids['Gone.md'])).not.toBeNull()
    await pruneDocumentStore({ expectedRoot: ROOT })
    expect(await index()).toEqual({ 'Kept.md': ids['Kept.md'] })
    expect(await desktop.readDocumentStore(ids['Gone.md'])).toBeNull()
  })

  it('prunes once per workspace in a window', async () => {
    const ids = await seed(['Gone.md'])
    await desktop.deleteWorkspaceDocument('Gone.md')
    await pruneDocumentStoreOnOpen(ROOT)
    await pruneDocumentStoreOnOpen(ROOT)
    // Aged once (kept until the next workspace open), not dropped by the second call.
    expect(await desktop.readDocumentStore(ids['Gone.md'])).not.toBeNull()
  })

  it('does not prune when the workspace lists no files', async () => {
    const ids = await seed(['Plan.md'])
    vi.mocked(desktop.listWorkspaceDocuments).mockResolvedValueOnce({ root_path: ROOT, items: [] })
    await pruneDocumentStore({ expectedRoot: ROOT })
    expect(await index()).toEqual({ 'Plan.md': ids['Plan.md'] })
  })

  it('gives a duplicate its own identity when opened', async () => {
    const ids = await seed(['Plan.md'])
    // A stale entry left at the copy's path is dropped.
    const stale = await seed(['Plan copy.md'])
    await desktop.deleteWorkspaceDocument('Plan copy.md')
    await writeFile('Plan copy.md', await fileText('Plan.md'))
    await duplicateDocumentIdentity('Plan.md', 'Plan copy.md')
    expect(await index()).toEqual({ 'Plan.md': ids['Plan.md'] })
    expect(await desktop.readDocumentStore(stale['Plan copy.md'])).toBeNull()

    const copy = await open('Plan copy.md', 2n)
    expect(copy.isNew).toBe(true)
    expect(copy.replica.docId).not.toBe(ids['Plan.md'])
  })

  it('re-reads and retries when another writer changed the index meanwhile', async () => {
    const ids = await seed(['Plan.md'])
    const actual = vi.mocked(desktop.writeDocumentIndex).getMockImplementation()!
    vi.mocked(desktop.writeDocumentIndex).mockImplementationOnce(async () => {
      // Another window records a document between our read and our write.
      const current = await desktop.readDocumentIndex()
      await actual({ ...current.entries, 'Other.md': 'other-doc' }, current.version)
      throw new Error('DOCUMENT_INDEX_CONFLICT')
    })

    await renameDocument('Plan.md', 'Renamed.md')
    expect(await index()).toEqual({ 'Renamed.md': ids['Plan.md'], 'Other.md': 'other-doc' })
    expect(desktop.writeDocumentIndex).toHaveBeenCalledTimes(3)
  })

  it('gives up after repeated conflicts', async () => {
    await seed(['Plan.md'])
    vi.mocked(desktop.writeDocumentIndex).mockClear()
    for (let attempt = 0; attempt < 4; attempt += 1) vi.mocked(desktop.writeDocumentIndex).mockRejectedValueOnce(new Error('DOCUMENT_INDEX_CONFLICT'))
    await expect(renameDocument('Plan.md', 'Renamed.md')).rejects.toThrow('DOCUMENT_INDEX_CONFLICT')
    expect(desktop.writeDocumentIndex).toHaveBeenCalledTimes(4)
  })

  it('does nothing for a path the index does not name', async () => {
    await seed(['Plan.md'])
    vi.mocked(desktop.writeDocumentIndex).mockClear()
    await renameDocument('Board.kiboard', 'Renamed.kiboard')
    await forgetDocument('Gone.md')
    expect(desktop.writeDocumentIndex).not.toHaveBeenCalled()
  })
})
