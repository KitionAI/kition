import type { QueryAST, QueryNode, OpName } from '../types'

// All recognized operator names
const KNOWN_OPS = new Set<OpName>([
  'file', 'path', 'tag', 'section', 'block', 'line',
  'task', 'task-todo', 'task-done',
  'kitable', 'field', 'view',
  'regex', 'match-case',
])

// Operators that map to 'field' node kind (not line/regex/match-case)
type FieldOp = Exclude<OpName, 'line' | 'regex' | 'match-case'>

function isFieldOp(op: OpName): op is FieldOp {
  return op !== 'line' && op !== 'regex' && op !== 'match-case'
}

// ---------------------------------------------------------------------------
// Lexer: produces raw tokens from the input string
// ---------------------------------------------------------------------------

type RawToken =
  | { type: 'word';  text: string }
  | { type: 'quote'; text: string; closed: boolean }
  | { type: 'op';    name: string; raw: string }      // name:... (raw = everything after name:)
  | { type: 'minus' }

function lex(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    // skip whitespace
    if (/\s/.test(input[i])) { i++; continue }

    // minus prefix: only counts as negation if followed immediately by " or a non-space
    if (input[i] === '-') {
      // Peek ahead: if next char is non-whitespace and not end-of-string, treat as negation
      if (i + 1 < len && !/\s/.test(input[i + 1])) {
        tokens.push({ type: 'minus' })
        i++
        continue
      }
      // Otherwise fall through to word handling
    }

    // quoted string
    if (input[i] === '"') {
      i++ // skip opening quote
      let content = ''
      let closed = false
      while (i < len) {
        if (input[i] === '"') { closed = true; i++; break }
        content += input[i++]
      }
      tokens.push({ type: 'quote', text: content, closed })
      continue
    }

    // word / operator: read until whitespace
    let j = i
    while (j < len && !/\s/.test(input[j])) j++
    const word = input.slice(i, j)
    i = j

    // Check if this looks like an operator: word contains `:` and text before `:` is a known op
    const colonIdx = word.indexOf(':')
    if (colonIdx > 0) {
      const candidate = word.slice(0, colonIdx)
      if (KNOWN_OPS.has(candidate as OpName)) {
        const raw = word.slice(colonIdx + 1) // everything after the colon
        tokens.push({ type: 'op', name: candidate, raw })
        continue
      }
    }

    tokens.push({ type: 'word', text: word })
  }

  return tokens
}

// ---------------------------------------------------------------------------
// Parser: converts raw tokens into QueryAST nodes
// ---------------------------------------------------------------------------

function parseRegexValue(raw: string): { source: string; flags: string } | null {
  // raw looks like: /pattern/flags  or  /pattern/
  if (!raw.startsWith('/')) return null
  let i = 1
  let source = ''
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length && raw[i + 1] === '/') {
      source += '/'
      i += 2
    } else if (raw[i] === '/') {
      break
    } else {
      source += raw[i++]
    }
  }
  if (i >= raw.length || raw[i] !== '/') return null // no closing slash
  const flags = raw.slice(i + 1)
  return { source, flags }
}

function parseLineValue(raw: string): { from: number; to: number } | null {
  // line:5-20  or  line:42
  const rangeMatch = /^(\d+)-(\d+)$/.exec(raw)
  if (rangeMatch) {
    return { from: parseInt(rangeMatch[1], 10), to: parseInt(rangeMatch[2], 10) }
  }
  const singleMatch = /^(\d+)$/.exec(raw)
  if (singleMatch) {
    const n = parseInt(singleMatch[1], 10)
    return { from: n, to: n }
  }
  return null
}

function parseOpNode(name: OpName, raw: string, matchCase: boolean): QueryNode | null {
  if (name === 'line') {
    // If raw is empty, check if next word might be a number — but we operate token-by-token;
    // bare line: with no value is not valid, drop it.
    if (!raw) return null
    const range = parseLineValue(raw)
    if (!range) return null
    return { kind: 'range', op: 'line', ...range }
  }

  if (name === 'regex') {
    // raw might be the whole /pattern/flags as a single word token
    const parsed = parseRegexValue(raw)
    if (!parsed || parsed.source === '') return null // drop empty regex
    return { kind: 'regex', source: parsed.source, flags: parsed.flags }
  }

  if (name === 'match-case') {
    // boolean flag — handled separately, returns null to skip adding a node
    return null
  }

  // All remaining ops map to 'field' node
  let value = raw

  // Handle quoted value (e.g. section:"Daily Notes")
  if (value.startsWith('"')) {
    // strip surrounding quotes
    if (value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1)
    } else {
      // unclosed quote — strip leading quote, keep rest
      value = value.slice(1)
    }
  }

  // Strip leading # from tag
  if (name === 'tag' && value.startsWith('#')) {
    value = value.slice(1)
  }

  // Strip leading ^ from block
  if (name === 'block' && value.startsWith('^')) {
    value = value.slice(1)
  }

  if (!isFieldOp(name)) return null
  return { kind: 'field', op: name, value }
}

export function parseQuery(input: string): QueryAST {
  const ast: QueryAST = {
    must: [],
    mustNot: [],
    flags: { matchCase: false },
  }

  if (!input.trim()) return ast

  // First pass: detect match-case flag so we know whether to lowercase subsequent tokens
  // We do a quick scan before full parsing.
  const rawTokens = lex(input)

  // Check for match-case flag upfront
  for (const tok of rawTokens) {
    if (tok.type === 'op' && tok.name === 'match-case') {
      ast.flags.matchCase = true
      break
    }
  }

  // Second pass: build AST nodes
  let i = 0
  while (i < rawTokens.length) {
    const tok = rawTokens[i]

    if (tok.type === 'minus') {
      i++
      // Next token is negated
      if (i >= rawTokens.length) break
      const next = rawTokens[i]
      const node = buildNode(next, ast.flags.matchCase, rawTokens, i)
      if (node.advance > 0) i += node.advance
      if (node.node) {
        ast.mustNot.push(node.node)
      }
      continue
    }

    const result = buildNode(tok, ast.flags.matchCase, rawTokens, i)
    if (result.advance > 0) i += result.advance
    if (result.node) {
      // match-case op contributes no node but sets flag (already handled above)
      ast.must.push(result.node)
    }
  }

  return ast
}

type BuildResult = { node: QueryNode | null; advance: number }

function buildNode(
  tok: RawToken,
  matchCase: boolean,
  _tokens: RawToken[],
  _idx: number,
): BuildResult {
  switch (tok.type) {
    case 'word': {
      const value = matchCase ? tok.text : tok.text.toLowerCase()
      return { node: { kind: 'term', value }, advance: 1 }
    }

    case 'quote': {
      const value = matchCase ? tok.text : tok.text.toLowerCase()
      if (!tok.closed) {
        // Unclosed quote: treat as a bare term (the whole content, no crash)
        return { node: { kind: 'term', value }, advance: 1 }
      }
      return { node: { kind: 'phrase', value }, advance: 1 }
    }

    case 'op': {
      const name = tok.name as OpName

      if (name === 'match-case') {
        // Flag-only, no AST node; flag already set in first pass
        return { node: null, advance: 1 }
      }

      // Special handling for section with quoted value:
      // The lexer sees `section:"Daily Notes"` as a single word because quotes are embedded.
      // But actually the lexer reads until whitespace, so `section:"Daily Notes"` with a space
      // between the two words means raw = `"Daily`, and "Notes"` is a separate token.
      // We need to handle this: if raw starts with `"` and doesn't end with `"`, consume more tokens.
      let raw = tok.raw
      if (raw.startsWith('"') && !raw.endsWith('"')) {
        // Need to consume tokens until closing quote
        let j = _idx + 1
        let combined = raw.slice(1) // strip opening quote
        let closed = false
        const tokens = _tokens
        while (j < tokens.length) {
          const next = tokens[j]
          if (next.type === 'word') {
            combined += ' ' + next.text
            j++
            if (next.text.endsWith('"')) {
              combined = combined.slice(0, -1) // remove trailing quote char
              closed = true
              break
            }
          } else if (next.type === 'quote') {
            // this shouldn't happen in normal flow but handle gracefully
            combined += ' ' + next.text
            j++
            closed = true
            break
          } else {
            break
          }
        }
        // reconstruct raw as quoted form (now without the quotes)
        raw = '"' + combined + (closed ? '"' : '')
        const advance = j - _idx
        const node = parseOpNode(name, raw, matchCase)
        return { node, advance }
      }

      // For regex op: raw is the /pattern/flags part
      // Handle regex case where value might be split across space — but regex values typically don't have spaces
      const node = parseOpNode(name, raw, matchCase)
      return { node, advance: 1 }
    }

    case 'minus': {
      // Should not reach here normally (handled in main loop)
      return { node: null, advance: 1 }
    }
  }
}
