/**
 * The store's view after undo, redo, and imports (re-read incrementally) against the view a full
 * read gives: a new store over a snapshot of the same document.
 */
import { describe, expect, it } from 'vitest'
import { person, Replica, Rng } from '@/lib/kdm'
import { boardSchema } from '../kdm/boardSchema'
import { BoardStore } from './boardStore'
import { createBoardElementRecord, type BoardElementRecord, type BoardRecord } from './boardRecords'
import type { WhiteboardElement } from './whiteboardTypes'

const other = person('user:other')

const viewOf = (records: readonly BoardRecord[]) => new Map(records.filter((record) => record.record_type !== 'meta').map((record) => [record.id, record]))
const fullView = (store: BoardStore) => viewOf(new BoardStore(Replica.load(boardSchema, store.snapshot(), 99n)).getRecords())

function element(id: string, kind: 'rectangle' | 'frame' | 'connector', pageId: string, index: number, rng: Rng): BoardElementRecord {
  const x = rng.below(400)
  const y = rng.below(400)
  const shape: WhiteboardElement = kind === 'connector'
    ? { id, kind: 'connector', start: { x, y }, end: { x: x + 40, y: y + 40 } }
    : kind === 'frame'
      ? { id, kind: 'rectangle', shapeType: 'frame', shapeStyle: 'frame', x, y, width: 200, height: 200 } as WhiteboardElement
      : { id, kind: 'rectangle', x, y, width: 20, height: 20, text: rng.below(2) ? `label ${id}` : undefined } as WhiteboardElement
  return createBoardElementRecord({ element: shape, index, pageId })
}

describe('BoardStore view after undo, redo, and imports', () => {
  it('equals a full read of the document after random sequences', () => {
    for (const seed of [11, 12, 13, 14]) {
      const rng = new Rng(seed)
      const store = new BoardStore()
      const remote = Replica.load(boardSchema, store.snapshot(), 7n)
      let serial = 0
      let checks = 0
      const elements = () => store.getRecords().filter((record): record is BoardElementRecord => record.record_type === 'element')
      const pick = <T,>(items: readonly T[]) => items[rng.below(items.length)]

      const local = () => {
        const all = elements()
        const pages = store.getPages()
        const page = pick(pages).id
        switch (rng.below(8)) {
          case 0:
          case 1: {
            serial += 1
            const kind = pick(['rectangle', 'rectangle', 'frame', 'connector'] as const)
            const id = `${seed}-${serial}`
            store.transact('add', (tx) => {
              tx.put(element(id, kind, page, store.getNextElementIndex(page), rng))
              const targets = all.filter((record) => record.page_id === page && record.kind === 'rectangle')
              if (kind === 'connector' && targets.length > 0) {
                tx.put({ record_type: 'binding', id: `binding:${id}:start`, binding_type: 'connector', from_id: id, to_id: pick(targets).id, terminal: 'start', to_anchor: { x: 0.5, y: 0.5 } })
              }
            })
            break
          }
          case 2:
            if (all.length > 0) {
              const victim = pick(all)
              store.transact('delete', (tx) => {
                tx.remove(victim.id)
                for (const binding of store.getRecords()) {
                  if (binding.record_type === 'binding' && (binding.from_id === victim.id || binding.to_id === victim.id)) tx.remove(binding.id)
                }
              })
            }
            break
          case 3:
            if (all.length > 0) {
              const moved = pick(all)
              store.transact('move', (tx) => tx.put({ ...moved, x: rng.below(400) } as BoardElementRecord))
            }
            break
          case 4: {
            const onPage = all.filter((record) => record.page_id === page).sort((a, b) => a.index - b.index)
            if (onPage.length > 1) {
              const last = onPage[onPage.length - 1]
              store.transact('to front', (tx) => {
                tx.put({ ...last, index: 0 } as BoardElementRecord)
                for (const record of onPage.slice(0, -1)) tx.put({ ...record, index: record.index + 1 } as BoardElementRecord)
              })
            }
            break
          }
          case 5: {
            const frames = all.filter((record) => record.kind === 'rectangle' && record.shapeType === 'frame')
            const child = pick(all)
            if (frames.length > 0 && child) {
              store.transact('nest', (tx) => tx.put({ ...child, parentId: pick(frames).id } as BoardElementRecord))
            }
            break
          }
          case 6:
            if (pages.length < 3) {
              serial += 1
              store.transact('page', (tx) => tx.put({ record_type: 'page', id: `page-${seed}-${serial}`, name: 'More', index: pages.length }))
            } else if (all.length > 0) {
              const moved = pick(all)
              const target = pick(pages).id
              store.transact('to page', (tx) => tx.put({ ...moved, page_id: target, index: store.getNextElementIndex(target) } as BoardElementRecord))
            }
            break
          case 7: {
            const mark = store.markHistory()
            serial += 1
            store.transact('a', (tx) => tx.put(element(`${seed}-${serial}`, 'rectangle', page, store.getNextElementIndex(page), rng)))
            if (all.length > 0) store.transact('b', (tx) => tx.put({ ...pick(all), y: rng.below(400) } as BoardElementRecord))
            if (rng.below(2)) store.squashToMark(mark, 'two')
            else store.bailToMark(mark)
            break
          }
        }
      }

      const remoteEdit = () => {
        remote.importChanges(store.getReplica().exportChanges())
        remote.transact(other, (tx) => {
          const pages = tx.listItems(rootOf(remote), 'pages').filter((id) => tx.exists(id))
          const page = pick(pages)
          if (!page) return
          const items = tx.listItems(page, 'elements').filter((id) => tx.exists(id))
          switch (rng.below(5)) {
            case 0:
              if (items.length > 0) tx.delete(pick(items))
              break
            case 1:
              if (items.length > 0) tx.set(pick(items), 'y', rng.below(400))
              break
            case 2:
              if (items.length > 1) tx.listMove(page, 'elements', 0, items.length - 1)
              break
            case 3:
              // An element listed on a second page, as concurrent moves leave it.
              if (items.length > 0) tx.listInsert(pick(pages), 'elements', 0, pick(items))
              break
            case 4: {
              serial += 1
              const id = `r${seed}-${serial}`
              tx.create('Element', { kind: 'rectangle', x: 1, y: 2, width: 3, height: 4, parent: items[0] ?? null }, { id })
              tx.listInsert(page, 'elements', 0, id)
              break
            }
          }
        })
        store.importChanges(remote.exportChanges())
      }

      for (let step = 0; step < 80; step += 1) {
        const action = rng.below(6)
        const revision = store.getSnapshot().revision
        if (action === 0) store.undo()
        else if (action === 1) store.redo()
        else if (action === 2) remoteEdit()
        else {
          local()
          continue
        }
        // Local commands keep the records they were given; only a re-read is compared.
        if (store.getSnapshot().revision === revision) continue
        checks += 1
        expect(viewOf(store.getRecords()), `seed ${seed}, step ${step}`).toEqual(fullView(store))
      }
      expect(checks).toBeGreaterThan(20)
    }
  })
})

function rootOf(replica: Replica) {
  return replica.objectsOfType('Board')[0]
}
