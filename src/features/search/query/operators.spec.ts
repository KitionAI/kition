import { describe, it, expect } from 'vitest'
import { applyPostFilters } from './operators'
import type { IndexableDoc, QueryAST, SearchHit } from '../types'

const noteHit = (over: Partial<IndexableDoc>): SearchHit => {
  const doc: IndexableDoc = {
    id: 'n1', kind: 'note', vaultPath: 'notes/foo.md', title: 'foo',
    body: 'hello world', tags: [],
    anchor: { kind: 'note', line: 10, ch: 0 },
    ...over,
  } as IndexableDoc
  return { id: doc.id, score: 1, doc, matches: [] }
}

describe('applyPostFilters', () => {
  it('file: filters by title substring', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'file', value: 'foo' }],
      mustNot: [], flags: { matchCase: false },
    }
    expect(applyPostFilters([noteHit({}), noteHit({ id: 'n2', title: 'bar' })], ast)
      .map(h => h.id)).toEqual(['n1'])
  })

  it('path: filters by vaultPath prefix', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'path', value: 'notes/' }],
      mustNot: [], flags: { matchCase: false },
    }
    const out = applyPostFilters(
      [noteHit({}), noteHit({ id: 'n2', vaultPath: 'attachments/x.png' })], ast)
    expect(out.map(h => h.id)).toEqual(['n1'])
  })

  it('tag: matches exact (with or without leading #)', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'tag', value: '#project/alpha' }],
      mustNot: [], flags: { matchCase: false },
    }
    const out = applyPostFilters(
      [noteHit({ tags: ['project/alpha'] }), noteHit({ id: 'n2', tags: ['other'] })], ast)
    expect(out.map(h => h.id)).toEqual(['n1'])
  })

  it('line:5-20 keeps only notes in range', () => {
    const ast: QueryAST = {
      must: [{ kind: 'range', op: 'line', from: 5, to: 20 }],
      mustNot: [], flags: { matchCase: false },
    }
    const out = applyPostFilters(
      [noteHit({ anchor: { kind: 'note', line: 10, ch: 0 } }),
       noteHit({ id: 'n2', anchor: { kind: 'note', line: 50, ch: 0 } })], ast)
    expect(out.map(h => h.id)).toEqual(['n1'])
  })

  it('task-todo: keeps only todo-tagged paragraphs', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'task-todo', value: '' }],
      mustNot: [], flags: { matchCase: false },
    }
    const out = applyPostFilters(
      [noteHit({ tags: ['__task__', '__task_todo__'] }),
       noteHit({ id: 'n2', tags: ['__task__', '__task_done__'] })], ast)
    expect(out.map(h => h.id)).toEqual(['n1'])
  })

  it('kitable: matches via kitable:<table> tag', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'kitable', value: 'orders' }],
      mustNot: [], flags: { matchCase: false },
    }
    const rec = noteHit({
      id: 'k1', kind: 'kitable_record', tags: ['kitable:Orders'],
      anchor: { kind: 'record', tableId: 't1', recordId: 'r1' },
    })
    expect(applyPostFilters([noteHit({}), rec], ast).map(h => h.id)).toEqual(['k1'])
  })

  it('field: on record matches "<name>:" in body', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'field', value: 'notes' }],
      mustNot: [], flags: { matchCase: false },
    }
    const rec = noteHit({
      id: 'k1', kind: 'kitable_record', body: 'Customer: Alex\nNotes: Revenue anomaly',
      anchor: { kind: 'record', tableId: 't1', recordId: 'r1' },
    })
    expect(applyPostFilters([noteHit({}), rec], ast).map(h => h.id)).toEqual(['k1'])
  })

  it('phrase: requires exact body substring', () => {
    const ast: QueryAST = {
      must: [{ kind: 'phrase', value: 'go to market' }],
      mustNot: [], flags: { matchCase: false },
    }
    const a = noteHit({ body: 'we go to market today' })
    const b = noteHit({ id: 'n2', body: 'market go to' })
    expect(applyPostFilters([a, b], ast).map(h => h.id)).toEqual(['n1'])
  })

  it('exclusion (-term) drops hits whose body contains the term', () => {
    const ast: QueryAST = {
      must: [], mustNot: [{ kind: 'term', value: 'refund' }],
      flags: { matchCase: false },
    }
    const a = noteHit({ body: 'Revenue anomaly' })
    const b = noteHit({ id: 'n2', body: 'Refund process' })
    expect(applyPostFilters([a, b], ast).map(h => h.id)).toEqual(['n1'])
  })

  it('mustNot phrase node is silently ignored — hit is NOT dropped', () => {
    // spec §6.3: only term strictly applies in mustNot; phrase does not participate
    const ast: QueryAST = {
      must: [{ kind: 'term', value: 'foo' }],
      mustNot: [{ kind: 'phrase', value: 'phrase to ignore' }],
      flags: { matchCase: false },
    }
    const a = noteHit({ body: 'foo and phrase to ignore here' })
    // The phrase appears in body, but mustNot phrase must be silently ignored — hit stays
    expect(applyPostFilters([a], ast).map(h => h.id)).toEqual(['n1'])
  })

  it('field: on kitable_meta with metaKind=field matches by title', () => {
    const ast: QueryAST = {
      must: [{ kind: 'field', op: 'field', value: 'notes' }],
      mustNot: [], flags: { matchCase: false },
    }
    const metaDoc = noteHit({
      id: 'm1', kind: 'kitable_meta', title: 'Notes',
      body: '', tags: ['kitable:Orders'],
      anchor: { kind: 'meta', metaKind: 'field', tableId: 't1', metaId: 'f1' },
    })
    expect(applyPostFilters([noteHit({}), metaDoc], ast).map(h => h.id)).toEqual(['m1'])
  })

  it('match-case toggles case sensitivity for phrase', () => {
    const a = noteHit({ body: 'Hello World' })
    const ast: QueryAST = {
      must: [{ kind: 'phrase', value: 'hello' }],
      mustNot: [], flags: { matchCase: true },
    }
    expect(applyPostFilters([a], ast)).toEqual([])
    expect(applyPostFilters([a], { ...ast, flags: { matchCase: false } })).toHaveLength(1)
  })
})
