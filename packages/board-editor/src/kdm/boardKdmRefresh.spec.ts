/**
 * The incremental re-read (`refreshBoardView`) against a full read, after random edits, imports,
 * undo, and redo: duplicates across pages, deleted pages and elements, dangling ids, and kinds the
 * reader does not know included.
 */
import { describe, expect, it } from 'vitest'
import { parseSchema, person, Replica, Rng, type Tx } from '@kition/kdm'
import { boardSchema } from './boardSchema'
import { readBoardView, refreshBoardView, type BoardViewRead } from './boardKdmRead'

const me = person('user:test')
const other = person('user:other')

/** The board schema of a later build that knows one more element kind. */
function futureSchema() {
  const source = JSON.parse(JSON.stringify(boardSchema)) as { types: { Element: { fields: { kind: { values: string[] } } } } }
  source.types.Element.fields.kind.values.push('sticker')
  return parseSchema(source)
}

const KINDS = ['rectangle', 'rectangle', 'connector', 'stroke', 'sticker'] as const

function fieldsFor(kind: string, rng: Rng, targets: readonly string[]): Record<string, unknown> {
  const at = { x: rng.below(100), y: rng.below(100) }
  if (kind === 'connector') {
    const fields: Record<string, unknown> = { kind, start: at, end: { x: at.x + 10, y: at.y + 10 } }
    if (targets.length > 0) fields.startBinding = { target: targets[rng.below(targets.length)], anchor: { x: 0.5, y: rng.below(3) / 2 } }
    if (targets.length > 0 && rng.below(2) === 0) fields.endBinding = { target: targets[rng.below(targets.length)], anchor: null }
    return fields
  }
  if (kind === 'stroke') return { kind, points: [at, { x: at.x + 1, y: at.y + 2 }] }
  return { kind, ...at, width: 10 + rng.below(5), height: 10 }
}

/** Snapshot of a read that compares records by id, whatever their order. */
const shape = (read: BoardViewRead) => ({
  rootId: read.rootId,
  records: new Map(read.records),
  pages: read.layout.pages.map((page) => ({ ...page })),
  placement: new Map(read.layout.placement),
  hidden: new Map(read.hidden),
})

describe('refreshBoardView', () => {
  it('equals a full read after random edits, imports, undo, and redo', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = new Rng(seed)
      const mine = Replica.create(boardSchema, '018f3a5e-7c1d-7000-8000-00000000000' + seed, 1n)
      mine.transact(me, (tx) => {
        const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
        for (const [index, id] of ['p1', 'p2', 'p3'].entries()) {
          tx.create('Page', { name: id }, { id })
          tx.listInsert(root, 'pages', index, id)
        }
      })
      const theirs = Replica.load(futureSchema(), mine.snapshot(), 2n)
      let serial = 0
      let refreshed = 0

      const edit = (replica: Replica, origin: typeof me, schemaKinds: readonly string[]) => replica.transact(origin, (tx: Tx) => {
        const pages = ['p1', 'p2', 'p3', 'p4'].filter((id) => tx.exists(id))
        const page = pages[rng.below(pages.length)]
        if (!page) return
        const items = tx.listItems(page, 'elements')
        const live = items.filter((id) => tx.exists(id))
        switch (rng.below(9)) {
          case 0:
          case 1: {
            serial += 1
            const id = `e${seed}-${serial}`
            const kind = schemaKinds[rng.below(schemaKinds.length)]
            tx.create('Element', fieldsFor(kind, rng, live), { id })
            if (kind === 'rectangle' && rng.below(2) === 0) tx.textInsert(id, 'text', 0, `label ${serial}`)
            tx.listInsert(page, 'elements', rng.below(items.length + 1), id)
            break
          }
          case 2:
            if (live.length > 0) tx.delete(live[rng.below(live.length)])
            break
          case 3:
            if (items.length > 1) tx.listMove(page, 'elements', rng.below(items.length), rng.below(items.length))
            break
          case 4:
            if (items.length > 0) tx.listRemove(page, 'elements', rng.below(items.length))
            break
          case 5: {
            // The same element listed on a second page, as a merge leaves it.
            const target = pages[rng.below(pages.length)]
            if (live.length > 0) tx.listInsert(target, 'elements', 0, live[rng.below(live.length)])
            break
          }
          case 6:
            if (live.length > 0) {
              const id = live[rng.below(live.length)]
              if (tx.get(id, 'kind') !== 'stroke' && tx.get(id, 'kind') !== 'connector') tx.set(id, 'x', rng.below(500))
              else tx.set(id, 'rotation', rng.below(90))
            }
            break
          case 7:
            if (live.length > 1) tx.set(live[0], 'parent', live[1])
            break
          case 8:
            if (rng.below(4) === 0 && tx.exists('p2')) tx.delete('p2')
            else if (!tx.exists('p4') && rng.below(3) === 0) {
              tx.create('Page', { name: 'Four' }, { id: 'p4' })
              tx.listInsert('board', 'pages', tx.listItems('board', 'pages').length, 'p4')
            } else tx.listInsert(page, 'elements', 0, `dangling-${rng.below(3)}`)
            break
        }
      })

      let previous = readBoardView(mine)
      mine.takeChanged()
      for (let step = 0; step < 120; step += 1) {
        const action = rng.below(6)
        if (action === 0) {
          edit(theirs, other, KINDS)
          mine.importChanges(theirs.exportChanges())
        } else if (action === 1) {
          edit(mine, me, KINDS.filter((kind) => kind !== 'sticker'))
          theirs.importChanges(mine.exportChanges())
        } else if (action === 2) mine.undo()
        else if (action === 3) mine.redo()
        else edit(mine, me, KINDS.filter((kind) => kind !== 'sticker'))
        const changed = mine.takeChanged()
        const next = refreshBoardView(mine, previous, changed)
        if (next) refreshed += 1
        const full = readBoardView(mine)
        expect(shape(next ?? full), `seed ${seed}, step ${step}`).toEqual(shape(full))
        previous = next ?? full
      }
      expect(refreshed).toBeGreaterThan(60)
    }
  })

  it('falls back to a full read when the root changes or many objects do', () => {
    const doc = Replica.create(boardSchema, '018f3a5e-7c1d-7000-8000-000000000009', 1n)
    doc.transact(me, (tx) => {
      const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
      tx.create('Page', { name: 'One' }, { id: 'p1' })
      tx.listInsert(root, 'pages', 0, 'p1')
    })
    const read = readBoardView(doc)
    expect(refreshBoardView(doc, read, new Set())).toBe(read)
    expect(refreshBoardView(doc, read, new Set(['board']))).toBeNull()
    expect(refreshBoardView(doc, read, new Set(Array.from({ length: 17 }, (_, index) => `x${index}`)))).toBeNull()
  })
})
