import { create, insertMultiple, search, remove } from '@orama/orama'
import type { Orama } from '@orama/orama'
import { segment } from '../query/tokenize'
import type { IndexableDoc, QueryAST, SearchHit } from '../types'

const schema = {
  id: 'string',
  kind: 'enum',
  vaultPath: 'string',
  title: 'string',
  body: 'string',
  tags: 'string[]',
} as const

export type IndexHandle = {
  db: Orama<typeof schema>
  anchors: Map<string, IndexableDoc['anchor']>
  bodies: Map<string, string>
  fullDocs: Map<string, IndexableDoc>
  bulkInsert(docs: IndexableDoc[]): Promise<void>
  removeIds(ids: string[]): Promise<void>
  query(ast: QueryAST, limit: number): Promise<SearchHit[]>
  size(): number
  serializeDocs(): IndexableDoc[]
  restoreDocs(docs: IndexableDoc[]): void
}

function tagsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? []
  const bb = b ?? []
  if (aa.length !== bb.length) return false
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false
  return true
}

function computeMatches(body: string, ast: QueryAST): Array<{ start: number; end: number }> {
  const needles: string[] = []
  for (const n of ast.must) {
    if ((n.kind === 'term' || n.kind === 'phrase') && n.value) needles.push(n.value)
  }
  if (needles.length === 0 || !body) return []
  const caseSensitive = ast.flags.matchCase
  const haystack = caseSensitive ? body : body.toLowerCase()
  const out: Array<{ start: number; end: number }> = []
  for (const t of needles) {
    const needle = caseSensitive ? t : t.toLowerCase()
    if (!needle) continue
    let from = 0
    while (from <= haystack.length) {
      const idx = haystack.indexOf(needle, from)
      if (idx === -1) break
      out.push({ start: idx, end: idx + needle.length })
      from = idx + needle.length
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

export async function createOramaIndex(): Promise<IndexHandle> {
  // create() is synchronous in orama v3
  const db = create({
    schema,
    components: {
      tokenizer: {
        language: 'english',
        normalizationCache: new Map(),
        tokenize: (raw: string) => segment(raw),
      } as any,
    },
  })

  const anchors = new Map<string, IndexableDoc['anchor']>()
  const bodies = new Map<string, string>()
  const fullDocs = new Map<string, IndexableDoc>()

  return {
    db, anchors, bodies, fullDocs,
    async bulkInsert(docs) {
      const toInsert: IndexableDoc[] = []
      const toReplace: IndexableDoc[] = []
      for (const d of docs) {
        const existing = fullDocs.get(d.id)
        if (!existing) { toInsert.push(d); continue }
        const changed = existing.body !== d.body
          || existing.title !== d.title
          || existing.vaultPath !== d.vaultPath
          || existing.kind !== d.kind
          || !tagsEqual(existing.tags, d.tags)
        if (changed) toReplace.push(d)
      }
      for (const d of toReplace) await remove(db, d.id)
      const all = toInsert.length + toReplace.length === 0 ? [] : [...toInsert, ...toReplace]
      if (all.length > 0) {
        const slim = all.map(({ id, kind, vaultPath, title, body, tags }) =>
          ({ id, kind, vaultPath, title, body, tags }))
        await insertMultiple(db, slim as any)
      }
      for (const d of all) {
        anchors.set(d.id, d.anchor)
        bodies.set(d.id, d.body)
        fullDocs.set(d.id, d)
      }
    },
    async removeIds(ids) {
      for (const id of ids) {
        await remove(db, id)
        anchors.delete(id)
        bodies.delete(id)
        fullDocs.delete(id)
      }
    },
    async query(ast, limit) {
      const terms = ast.must
        .filter((n): n is { kind: 'term'; value: string } => n.kind === 'term')
        .map(n => n.value)
      if (terms.length === 0) {
        const out: SearchHit[] = []
        for (const [id, doc] of fullDocs) {
          if (out.length >= limit) break
          out.push({ id, score: 0, doc, matches: [] })
        }
        return out
      }
      const term = terms.join(' ')
      const res: any = await search(db, { term, limit, properties: ['body', 'title', 'tags'] } as any)
      return res.hits.map((h: any): SearchHit => {
        const doc = fullDocs.get(h.id)!
        return {
          id: h.id,
          score: h.score ?? 0,
          doc,
          matches: doc ? computeMatches(doc.body, ast) : [],
        }
      }).filter((h: SearchHit) => h.doc !== undefined)
    },
    size() { return fullDocs.size },
    serializeDocs() {
      return Array.from(fullDocs.values())
    },
    restoreDocs(docs) {
      for (const d of docs) {
        anchors.set(d.id, d.anchor)
        bodies.set(d.id, d.body)
        fullDocs.set(d.id, d)
      }
    },
  }
}
