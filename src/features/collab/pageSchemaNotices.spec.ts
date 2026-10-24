import { afterEach, describe, expect, it, vi } from 'vitest'
import { Replica, Version, newDocId, parseSchema, person } from '@/lib/kdm'
import { documentSchemaNotice, setDocumentSchemaNotice } from '@/services/documentSchema'

type Followed = { path: string; replica: () => Replica; subscribe: (listener: () => void) => () => void }
const listeners = vi.hoisted(() => ({ markdown: [] as Array<(document: Followed) => () => void> }))
vi.mock('@/features/document/public', () => ({
  followOpenMarkdownDocuments: (listener: (document: Followed) => () => void) => {
    listeners.markdown.push(listener)
    return () => undefined
  },
}))

const { followPageSchemaNotices, newerAuthorNotice } = await import('./pageSchemaNotices')

const SCHEMA = { kdm: 1, kit: 'kit.document', schemaVersion: 1, root: 'Document', types: { Document: { fields: { title: { kind: 'string' } } } } }
const schema = (version: number) => parseSchema({ ...SCHEMA, schemaVersion: version })

/** A document replica, and one with a change a kit of schema `newer` made, as a relay or a file would bring it. */
function replicas(newer: number) {
  const mine = Replica.create(schema(1), newDocId(), 1n)
  const root = mine.transact(person('me'), (tx) => tx.create('Document', { title: 'Plan' }))
  const theirs = Replica.load(schema(newer), mine.snapshot(), 2n)
  theirs.transact(person('them'), (tx) => tx.set(root, 'title', 'Roadmap'))
  const edited = Replica.load(schema(1), mine.snapshot(), 3n)
  edited.importChanges(theirs.exportChanges(Version.empty()))
  return { mine, edited }
}

function followed(path: string, first: Replica) {
  let current = first
  const subscribers = new Set<() => void>()
  return {
    document: { path, replica: () => current, subscribe: (listener: () => void) => (subscribers.add(listener), () => void subscribers.delete(listener)) },
    replace: (next: Replica) => {
      current = next
      for (const listener of subscribers) listener()
    },
    changed: () => {
      for (const listener of subscribers) listener()
    },
  }
}

afterEach(() => {
  setDocumentSchemaNotice('Plan.md', null)
  setDocumentSchemaNotice('Notes.md', null)
})

describe('newerAuthorNotice', () => {
  it('asks for a notice only when a newer kit wrote some of the changes', () => {
    const { mine, edited } = replicas(2)
    expect(newerAuthorNotice(mine, 'kit.document')).toBeNull()
    expect(newerAuthorNotice(edited, 'kit.document')).toEqual({ kit: 'kit.document', reads: 1, needs: 2, blocked: false })
  })
})

describe('followPageSchemaNotices', () => {
  it("shows the notice of an open document a newer kit edited, follows the editor's replica, and takes it down when it closes", () => {
    const stop = followPageSchemaNotices()
    const { mine, edited } = replicas(3)
    const opened = followed('Plan.md', edited)
    const close = listeners.markdown.at(-1)!(opened.document)
    expect(documentSchemaNotice('Plan.md')).toEqual({ kit: 'kit.document', reads: 1, needs: 3, blocked: false })
    // Taken down while the document is open (a relay stopping): shown again with the next change.
    setDocumentSchemaNotice('Plan.md', null)
    opened.changed()
    expect(documentSchemaNotice('Plan.md')?.needs).toBe(3)
    // The file replaced by one no newer kit edited.
    opened.replace(mine)
    expect(documentSchemaNotice('Plan.md')).toBeNull()
    opened.replace(edited)
    expect(documentSchemaNotice('Plan.md')?.needs).toBe(3)
    close()
    expect(documentSchemaNotice('Plan.md')).toBeNull()
    stop()
  })

  it('shows none for a Markdown document no newer kit edited, and leaves a blocking notice alone', () => {
    const stop = followPageSchemaNotices()
    const { mine } = replicas(2)
    const close = listeners.markdown.at(-1)!(followed('Notes.md', mine).document)
    expect(documentSchemaNotice('Notes.md')).toBeNull()
    setDocumentSchemaNotice('Notes.md', { kit: 'kit.document', reads: 1, needs: 2, blocked: true })
    close()
    expect(documentSchemaNotice('Notes.md')?.blocked).toBe(true)
    stop()
  })
})
