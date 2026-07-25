import { describe, expect, it } from 'vitest'
import { parseQuery } from './parser'

describe('parseQuery', () => {
  it('parses a single bare term', () => {
    const ast = parseQuery('hello')
    expect(ast.must).toEqual([{ kind: 'term', value: 'hello' }])
    expect(ast.mustNot).toEqual([])
    expect(ast.flags.matchCase).toBe(false)
  })

  it('parses multiple bare terms as AND', () => {
    const ast = parseQuery('hello world')
    expect(ast.must).toEqual([
      { kind: 'term', value: 'hello' },
      { kind: 'term', value: 'world' },
    ])
  })

  it('lowercases terms by default', () => {
    const ast = parseQuery('HELLO')
    expect(ast.must).toEqual([{ kind: 'term', value: 'hello' }])
  })

  it('parses quoted phrase', () => {
    const ast = parseQuery('"hello world"')
    expect(ast.must).toEqual([{ kind: 'phrase', value: 'hello world' }])
  })

  it('parses negation prefix', () => {
    const ast = parseQuery('foo -bar')
    expect(ast.must).toEqual([{ kind: 'term', value: 'foo' }])
    expect(ast.mustNot).toEqual([{ kind: 'term', value: 'bar' }])
  })

  it('parses negated phrase', () => {
    const ast = parseQuery('-"go to market"')
    expect(ast.mustNot).toEqual([{ kind: 'phrase', value: 'go to market' }])
  })

  it('parses field operator: file', () => {
    const ast = parseQuery('file:Readme.md')
    expect(ast.must).toEqual([{ kind: 'field', op: 'file', value: 'Readme.md' }])
  })

  it('parses field operator: path', () => {
    const ast = parseQuery('path:notes/2026')
    expect(ast.must).toEqual([{ kind: 'field', op: 'path', value: 'notes/2026' }])
  })

  it('parses field operator: tag with leading #', () => {
    const ast = parseQuery('tag:#project/alpha')
    expect(ast.must).toEqual([{ kind: 'field', op: 'tag', value: 'project/alpha' }])
  })

  it('parses field operator: tag without leading #', () => {
    const ast = parseQuery('tag:project/alpha')
    expect(ast.must).toEqual([{ kind: 'field', op: 'tag', value: 'project/alpha' }])
  })

  it('parses task flag', () => {
    const ast = parseQuery('task:')
    expect(ast.must).toEqual([{ kind: 'field', op: 'task', value: '' }])
  })

  it('parses task-todo and task-done', () => {
    expect(parseQuery('task-todo:').must).toEqual([{ kind: 'field', op: 'task-todo', value: '' }])
    expect(parseQuery('task-done:').must).toEqual([{ kind: 'field', op: 'task-done', value: '' }])
  })

  it('parses section quoted value', () => {
    const ast = parseQuery('section:"Daily Notes"')
    expect(ast.must).toEqual([{ kind: 'field', op: 'section', value: 'Daily Notes' }])
  })

  it('parses block id', () => {
    const ast = parseQuery('block:^abc-123')
    expect(ast.must).toEqual([{ kind: 'field', op: 'block', value: 'abc-123' }])
  })

  it('parses line range', () => {
    const ast = parseQuery('line:5-20')
    expect(ast.must).toEqual([{ kind: 'range', op: 'line', from: 5, to: 20 }])
  })

  it('parses single line as 1-element range', () => {
    const ast = parseQuery('line:42')
    expect(ast.must).toEqual([{ kind: 'range', op: 'line', from: 42, to: 42 }])
  })

  it('parses match-case flag', () => {
    const ast = parseQuery('match-case: HELLO')
    expect(ast.flags.matchCase).toBe(true)
    expect(ast.must).toEqual([{ kind: 'term', value: 'HELLO' }])
  })

  it('parses regex literal', () => {
    const ast = parseQuery('regex:/foo.*bar/i')
    expect(ast.must).toEqual([{ kind: 'regex', source: 'foo.*bar', flags: 'i' }])
  })

  it('parses regex without flags', () => {
    const ast = parseQuery('regex:/^heading$/')
    expect(ast.must).toEqual([{ kind: 'regex', source: '^heading$', flags: '' }])
  })

  it('parses kitable, field, view operators', () => {
    expect(parseQuery('kitable:sales').must).toEqual([{ kind: 'field', op: 'kitable', value: 'sales' }])
    expect(parseQuery('field:notes').must).toEqual([{ kind: 'field', op: 'field', value: 'notes' }])
    expect(parseQuery('view:board').must).toEqual([{ kind: 'field', op: 'view', value: 'board' }])
  })

  it('mixes everything in one query', () => {
    const ast = parseQuery('foo "exact phrase" -bar file:Readme tag:project task-todo:')
    expect(ast.must).toEqual([
      { kind: 'term',   value: 'foo' },
      { kind: 'phrase', value: 'exact phrase' },
      { kind: 'field',  op: 'file', value: 'Readme' },
      { kind: 'field',  op: 'tag',  value: 'project' },
      { kind: 'field',  op: 'task-todo', value: '' },
    ])
    expect(ast.mustNot).toEqual([{ kind: 'term', value: 'bar' }])
  })

  // Tolerance / edge cases (Task 11)

  it('treats unclosed quote as a literal term starting with quote', () => {
    const ast = parseQuery('"unterminated text')
    // The parser should NOT throw; it should fall back to treating it as a term.
    expect(() => parseQuery('"unterminated text')).not.toThrow()
    expect(ast.must.length).toBeGreaterThan(0)
  })

  it('treats unknown operator as plain term', () => {
    const ast = parseQuery('weird:value')
    expect(ast.must).toEqual([{ kind: 'term', value: 'weird:value' }])
  })

  it('drops empty regex pattern', () => {
    const ast = parseQuery('regex://')
    expect(ast.must).toEqual([])
    expect(ast.mustNot).toEqual([])
  })

  it('strips leading # from tag', () => {
    expect(parseQuery('tag:#abc').must[0]).toEqual({ kind: 'field', op: 'tag', value: 'abc' })
    expect(parseQuery('tag:abc').must[0]).toEqual({ kind: 'field', op: 'tag', value: 'abc' })
  })

  it('strips leading ^ from block', () => {
    expect(parseQuery('block:^id').must[0]).toEqual({ kind: 'field', op: 'block', value: 'id' })
    expect(parseQuery('block:id').must[0]).toEqual({ kind: 'field', op: 'block', value: 'id' })
  })

  it('empty input produces empty AST', () => {
    const ast = parseQuery('')
    expect(ast.must).toEqual([])
    expect(ast.mustNot).toEqual([])
    expect(ast.flags.matchCase).toBe(false)
  })

  it('only whitespace produces empty AST', () => {
    const ast = parseQuery('   \t  ')
    expect(ast.must).toEqual([])
  })

  it('match-case affects phrases too', () => {
    const ast = parseQuery('match-case: "Hello World"')
    expect(ast.flags.matchCase).toBe(true)
    expect(ast.must).toEqual([{ kind: 'phrase', value: 'Hello World' }])
  })

  it('regex with escaped slash inside pattern', () => {
    const ast = parseQuery('regex:/foo\\/bar/i')
    expect(ast.must).toEqual([{ kind: 'regex', source: 'foo/bar', flags: 'i' }])
  })
})
