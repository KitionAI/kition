import { describe, it, expect } from 'vitest'
import { save, load } from '@orama/orama'
import { createOramaIndex } from './oramaIndex'
import type { IndexableDoc, QueryAST } from '../types'

const codePointText = (...values: number[]) => String.fromCodePoint(...values)
const sales = codePointText(0x9500, 0x552e)
const report = codePointText(0x62a5, 0x544a)
const salesAnomalyReport = codePointText(0x9500, 0x552e, 0x989d, 0x5f02, 0x5e38, 0x62a5, 0x544a)
const smallModel = codePointText(0x5c0f, 0x6a21, 0x578b)

const docs: IndexableDoc[] = [
  {
    id: '1', kind: 'note', vaultPath: 'a.md', title: 'a',
    body: salesAnomalyReport, tags: [],
    anchor: { kind: 'note', line: 1, ch: 0 },
  },
  {
    id: '2', kind: 'note', vaultPath: 'b.md', title: 'b',
    body: 'Hello world', tags: [],
    anchor: { kind: 'note', line: 1, ch: 0 },
  },
]

describe('oramaIndex', () => {
  it('inserts docs and finds Chinese token', async () => {
    const idx = await createOramaIndex()
    await idx.bulkInsert(docs)
    const ast: QueryAST = { must: [{ kind: 'term', value: sales }], mustNot: [], flags: { matchCase: false } }
    const hits = await idx.query(ast, 10)
    expect(hits.find(h => h.id === '1')).toBeTruthy()
    expect(hits.find(h => h.id === '2')).toBeFalsy()
  })

  it('finds English token', async () => {
    const idx = await createOramaIndex()
    await idx.bulkInsert(docs)
    const ast: QueryAST = { must: [{ kind: 'term', value: 'hello' }], mustNot: [], flags: { matchCase: false } }
    const hits = await idx.query(ast, 10)
    expect(hits.find(h => h.id === '2')).toBeTruthy()
  })

  it('survives save/restore — restored docs are queryable', async () => {
    const idx1 = await createOramaIndex()
    await idx1.bulkInsert(docs)

    // Mirror the worker's snapshot payload.
    const blob = JSON.stringify({ orama: save(idx1.db), docs: idx1.serializeDocs() })

    const idx2 = await createOramaIndex()
    const decoded = JSON.parse(blob)
    load(idx2.db, decoded.orama)
    idx2.restoreDocs(decoded.docs)

    const ast: QueryAST = { must: [{ kind: 'term', value: report }], mustNot: [], flags: { matchCase: false } }
    const hits = await idx2.query(ast, 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('1')
    // The side-channel fullDocs map is what the worker joins against — must be present.
    expect(hits[0].doc).toBeTruthy()
    expect(hits[0].doc.body).toBe(salesAnomalyReport)
  })

  it('bulkInsert is idempotent — re-inserting unchanged docs is a no-op', async () => {
    const idx = await createOramaIndex()
    await idx.bulkInsert(docs)
    // Same content again — must not throw "document already exists".
    await expect(idx.bulkInsert(docs)).resolves.toBeUndefined()
    expect(idx.size()).toBe(2)
    const ast: QueryAST = { must: [{ kind: 'term', value: 'hello' }], mustNot: [], flags: { matchCase: false } }
    expect((await idx.query(ast, 10)).length).toBe(1)
  })

  it('bulkInsert replaces docs when body changes', async () => {
    const idx = await createOramaIndex()
    await idx.bulkInsert(docs)
    const edited: IndexableDoc = { ...docs[1], body: 'Goodbye world' }
    await idx.bulkInsert([edited])
    const oldAst: QueryAST = { must: [{ kind: 'term', value: 'hello' }], mustNot: [], flags: { matchCase: false } }
    const newAst: QueryAST = { must: [{ kind: 'term', value: 'goodbye' }], mustNot: [], flags: { matchCase: false } }
    expect((await idx.query(oldAst, 10)).find(h => h.id === '2')).toBeFalsy()
    expect((await idx.query(newAst, 10)).find(h => h.id === '2')).toBeTruthy()
  })

  it('populates match ranges so the snippet can render <mark>', async () => {
    const idx = await createOramaIndex()
    await idx.bulkInsert([
      {
        id: 'a', kind: 'note', vaultPath: 'a.md', title: 'a',
        body: `Mac mini benchmark: ${smallModel} inference, then test another ${smallModel}`, tags: [],
        anchor: { kind: 'note', line: 1, ch: 0 },
      },
      {
        id: 'b', kind: 'note', vaultPath: 'b.md', title: 'b',
        body: 'Hello WORLD, hello again', tags: [],
        anchor: { kind: 'note', line: 1, ch: 0 },
      },
    ])

    const cjkAst: QueryAST = { must: [{ kind: 'term', value: smallModel }], mustNot: [], flags: { matchCase: false } }
    const cjkHits = await idx.query(cjkAst, 10)
    const cjkHit = cjkHits.find(h => h.id === 'a')!
    expect(cjkHit.matches.length).toBeGreaterThanOrEqual(2)
    expect(cjkHit.doc.body.slice(cjkHit.matches[0].start, cjkHit.matches[0].end)).toBe(smallModel)

    const latinAst: QueryAST = { must: [{ kind: 'term', value: 'hello' }], mustNot: [], flags: { matchCase: false } }
    const latinHits = await idx.query(latinAst, 10)
    const latinHit = latinHits.find(h => h.id === 'b')!
    expect(latinHit.matches.length).toBe(2)
    // Case-insensitive: matches both "Hello" and "hello" — extracted slice preserves original casing.
    expect(latinHit.doc.body.slice(latinHit.matches[0].start, latinHit.matches[0].end).toLowerCase()).toBe('hello')
  })
})
