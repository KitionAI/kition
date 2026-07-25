import type { IndexableDoc, QueryAST, QueryNode, SearchHit } from '../types'

function normalizeTag(s: string): string { return s.replace(/^#/, '').toLowerCase() }

function tableNameFromTags(tags: string[]): string | null {
  for (const t of tags) if (t.startsWith('kitable:')) return t.slice('kitable:'.length)
  return null
}

function nodeMatches(node: QueryNode, doc: IndexableDoc, matchCase: boolean): boolean {
  const cmp = (s: string) => matchCase ? s : s.toLowerCase()

  switch (node.kind) {
    case 'term': {
      return cmp(doc.body).includes(cmp(node.value))
        || cmp(doc.title).includes(cmp(node.value))
        || doc.tags.some(t => cmp(t).includes(cmp(node.value)))
    }
    case 'phrase': {
      return cmp(doc.body).includes(cmp(node.value))
    }
    case 'regex': {
      try {
        const flags = matchCase
          ? node.flags.replace('i', '')
          : (node.flags.includes('i') ? node.flags : node.flags + 'i')
        const re = new RegExp(node.source, flags)
        return re.test(doc.body)
      } catch { return false }
    }
    case 'range': {
      if (doc.anchor.kind !== 'note') return false
      return doc.anchor.line >= node.from && doc.anchor.line <= node.to
    }
    case 'field': {
      switch (node.op) {
        case 'file': return cmp(doc.title).includes(cmp(node.value))
        case 'path': return cmp(doc.vaultPath).startsWith(cmp(node.value))
        case 'tag':  return doc.tags.map(normalizeTag).includes(normalizeTag(node.value))
        case 'section':
          return doc.anchor.kind === 'note' && !!doc.anchor.section
            && cmp(doc.anchor.section).includes(cmp(node.value))
        case 'block':
          return doc.anchor.kind === 'note' && doc.anchor.blockId === node.value
        case 'task':       return doc.tags.includes('__task__')
        case 'task-todo':  return doc.tags.includes('__task_todo__')
        case 'task-done':  return doc.tags.includes('__task_done__')
        case 'kitable': {
          if (doc.kind !== 'kitable_record' && doc.kind !== 'kitable_meta') return false
          const tableName = tableNameFromTags(doc.tags)
          if (!tableName) return false
          return cmp(tableName).includes(cmp(node.value))
        }
        case 'field': {
          if (doc.kind === 'kitable_record') {
            const lines = doc.body.split('\n')
            return lines.some(l => cmp(l).startsWith(cmp(node.value) + ':'))
          }
          if (doc.kind === 'kitable_meta' && doc.anchor.kind === 'meta' && doc.anchor.metaKind === 'field') {
            return cmp(doc.title).includes(cmp(node.value))
          }
          return false
        }
        case 'view':
          return doc.kind === 'kitable_meta'
            && doc.anchor.kind === 'meta' && doc.anchor.metaKind === 'view'
            && cmp(doc.title).includes(cmp(node.value))
      }
    }
  }
}

export function applyPostFilters(hits: SearchHit[], ast: QueryAST): SearchHit[] {
  const { matchCase } = ast.flags
  const out: SearchHit[] = []
  for (const h of hits) {
    let ok = true
    for (const n of ast.must) {
      if (!nodeMatches(n, h.doc, matchCase)) { ok = false; break }
    }
    if (ok) {
      for (const n of ast.mustNot) {
        // Per spec §6.3: only 'term' nodes participate in mustNot; phrase/regex/field/range are silently ignored
        if (n.kind !== 'term') continue
        if (nodeMatches(n, h.doc, matchCase)) { ok = false; break }
      }
    }
    if (ok) out.push(h)
  }
  return out
}
