   
                  
  
                                                           
                                             
   

import type { FrontmatterField } from './frontmatter-parser'

export type SerializableValue = string | string[]

function needsQuotes(s: string): boolean {
  return /[:#'",\[\]\{\}\n]/.test(s) || s.trim() !== s || s === ''
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function fmtScalar(s: string): string {
  return needsQuotes(s) ? quote(s) : s
}

function serializeField(key: string, value: SerializableValue): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`
    const inline = value.map(fmtScalar).join(', ')
    if (inline.length <= 60 && !value.some(needsQuotes)) {
      return `${key}: [${inline}]`
    }
    return `${key}:\n${value.map((v) => `  - ${fmtScalar(v)}`).join('\n')}`
  }
  return `${key}: ${fmtScalar(value)}`
}

export function serializeFrontmatter(fields: Array<{ key: string; value: SerializableValue }>): string {
  if (fields.length === 0) return ''
  const body = fields.filter((f) => f.key.trim()).map((f) => serializeField(f.key.trim(), f.value)).join('\n')
  if (!body) return ''
  return `---\n${body}\n---\n`
}

   
                                             
   
export function applyFrontmatter(
  source: string,
  fields: Array<{ key: string; value: SerializableValue }>,
  parsed: { from: number; to: number } | null,
): string {
  const block = serializeFrontmatter(fields)
  if (parsed) {
                                           
    let end = parsed.to
    if (source[end] === '\n') end += 1
    const before = source.slice(0, parsed.from)
    const after = source.slice(end)
    return `${before}${block}${after}`
  }
  return `${block}${source}`
}

export type EditableField = {
  key: string
  value: SerializableValue
}

export function fieldsFromParsed(fields: FrontmatterField[]): EditableField[] {
  return fields.map((f) => ({ key: f.key, value: Array.isArray(f.value) ? [...f.value] : f.value }))
}
