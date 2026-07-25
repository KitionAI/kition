import { describe, it, expect } from 'vitest'
import { extractNoteDocs } from './noteSource'

describe('extractNoteDocs', () => {
  it('splits markdown into paragraphs at blank lines', () => {
    const md = 'First paragraph.\n\nSecond paragraph.\n\nThird.'
    const docs = extractNoteDocs({ vaultPath: 'notes/foo.md', content: md })
    expect(docs).toHaveLength(3)
    expect(docs[0].body).toBe('First paragraph.')
    expect(docs[1].body).toBe('Second paragraph.')
    expect(docs[2].body).toBe('Third.')
  })

  it('records line and section for headed paragraph', () => {
    const md = '# Daily Notes\n\nMet with sales.\n\n## Detail\n\nNumber: 100.'
    const docs = extractNoteDocs({ vaultPath: 'notes/x.md', content: md })
    const met = docs.find(d => d.body.includes('Met'))!
    const num = docs.find(d => d.body.includes('100'))!
    expect(met.anchor.kind).toBe('note')
    if (met.anchor.kind === 'note') {
      expect(met.anchor.section).toBe('Daily Notes')
      expect(met.anchor.line).toBe(2)
    }
    if (num.anchor.kind === 'note') {
      expect(num.anchor.section).toBe('Daily Notes › Detail')
    }
  })

  it('extracts #tags into doc.tags, skips code blocks', () => {
    const md = '#real-tag in body.\n\n```\n#fake-tag\n```\n\nMore #another/sub here.'
    const docs = extractNoteDocs({ vaultPath: 'a.md', content: md })
    const allTags = docs.flatMap(d => d.tags)
    expect(allTags).toContain('real-tag')
    expect(allTags).toContain('another/sub')
    expect(allTags).not.toContain('fake-tag')
  })

  it('marks task-todo and task-done paragraphs', () => {
    const md = '- [ ] Buy milk\n\n- [x] Done thing'
    const docs = extractNoteDocs({ vaultPath: 'todo.md', content: md })
    expect(docs[0].tags).toContain('__task__')
    expect(docs[0].tags).toContain('__task_todo__')
    expect(docs[1].tags).toContain('__task__')
    expect(docs[1].tags).toContain('__task_done__')
  })

  it('extracts ^block-id reference', () => {
    const md = 'Some content ^block-1'
    const docs = extractNoteDocs({ vaultPath: 'b.md', content: md })
    expect(docs[0].anchor.kind).toBe('note')
    if (docs[0].anchor.kind === 'note') {
      expect(docs[0].anchor.blockId).toBe('block-1')
    }
  })
})
