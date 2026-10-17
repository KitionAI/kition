// Copied from kition-sdk packages/kdm/src/marks.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Marks on text (Standard 2.0 rule M19): rich-text run properties a `text` field declares in the
 * schema; the twin of the Rust crate's `marks` module. Each mark key is its own last-writer-wins
 * value over ranges of characters; the schema's `expand` decides whether text typed at a marked
 * range's ends takes the mark.
 */
import type { LoroDoc, LoroText } from 'loro-crdt'
import { canonical, compareKeys, setKey } from './canonical'
import { markExpands, type FieldDef, type Schema } from './schema'
import type { JsonValue } from './value'

/**
 * One run of a text field: characters that carry the same marks. `Replica.textDelta` reads a
 * text field as runs in order; adjacent runs differ in their marks, no run is empty, and
 * `attributes` holds only the field's declared marks, keys sorted, values in canonical form. A run
 * without marks has no `attributes`.
 */
export interface TextRun {
  insert: string
  attributes?: Record<string, JsonValue>
}

/**
 * Tells the engine every mark key of the schema and its expand. The configuration is local to a
 * replica (the engine does not replicate it); every replica of a document configures it from the
 * same schema before it marks anything.
 */
export function configure(doc: LoroDoc, schema: Schema): void {
  const styles: Record<string, { expand: 'before' | 'after' | 'none' | 'both' }> = {}
  for (const [key, expand] of markExpands(schema)) setKey(styles, key, { expand })
  doc.configTextStyle(styles)
}

const sameAttributes = (a: Record<string, JsonValue> | undefined, b: Record<string, JsonValue> | undefined): boolean => {
  const left = a ? Object.keys(a).sort(compareKeys) : []
  const right = b ? Object.keys(b).sort(compareKeys) : []
  if (left.length !== right.length) return false
  return left.every((key, index) => key === right[index] && JSON.stringify(canonical(a![key])) === JSON.stringify(canonical(b![key])))
}

/** Appends a run, merging it into the last one when their marks are equal. */
export function pushRun(out: TextRun[], insert: string, attributes: Record<string, JsonValue> | undefined): void {
  if (insert === '') return
  const last = out[out.length - 1]
  if (last && sameAttributes(last.attributes, attributes)) {
    last.insert += insert
    return
  }
  out.push(attributes && Object.keys(attributes).length > 0 ? { insert, attributes } : { insert })
}

/**
 * A text field's runs as the canonical state reads them: only `def`'s declared marks, null
 * values (unmarked) dropped, empty runs dropped, adjacent runs with equal marks merged.
 */
export function runs(text: LoroText, def: FieldDef): TextRun[] {
  const declared = def.marks ?? {}
  const out: TextRun[] = []
  for (const delta of text.toDelta()) {
    const insert = (delta as { insert?: unknown }).insert
    if (typeof insert !== 'string' || insert === '') continue
    const raw = (delta as { attributes?: Record<string, unknown> }).attributes ?? {}
    let attributes: Record<string, JsonValue> | undefined
    for (const key of Object.keys(raw).sort(compareKeys)) {
      if (!Object.hasOwn(declared, key)) continue
      const value = raw[key]
      if (value === null || value === undefined) continue
      attributes ??= {}
      setKey(attributes, key, canonical(value) as JsonValue)
    }
    pushRun(out, insert, attributes)
  }
  return out
}
