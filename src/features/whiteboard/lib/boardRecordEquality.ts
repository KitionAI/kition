import type { BoardRecord } from './boardRecords'

/**
 * Whether two records mean the same thing: deep equality that ignores key order and treats a
 * member holding `undefined`, a rectangle's empty `text`, and an empty `style` (or one whose
 * values are all `undefined`) as absent. The store uses it to tell real changes from records
 * rebuilt in another shape, such as those read back from the KDM.
 */
export function boardRecordsEqual(a: BoardRecord, b: BoardRecord): boolean {
  return deepEqual(normalized(a), normalized(b))
}

function normalized(record: BoardRecord): Record<string, unknown> {
  const out = record as Record<string, unknown>
  const emptyText = record.record_type === 'element' && record.kind === 'rectangle' && record.text === ''
  const emptyStyle = 'style' in out && isEmptyStyle(out.style)
  if (!emptyText && !emptyStyle) return out
  const copy = { ...out }
  if (emptyText) delete copy.text
  if (emptyStyle) delete copy.style
  return copy
}

function isEmptyStyle(style: unknown): boolean {
  return style !== null
    && typeof style === 'object'
    && !Array.isArray(style)
    && Object.values(style).every((value) => value === undefined)
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number') return Number.isNaN(left) && Number.isNaN(right)
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = definedKeys(leftRecord)
  if (keys.length !== definedKeys(rightRecord).length) return false
  return keys.every((key) => rightRecord[key] !== undefined && deepEqual(leftRecord[key], rightRecord[key]))
}

function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined)
}
