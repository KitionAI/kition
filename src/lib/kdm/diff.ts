// Copied from kition-sdk packages/kdm/src/diff.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The object-level difference between two canonical states of one document (standard 2.0 A13):
 * what a draft created, changed, and deleted, for the comparison a person reviews before merging
 * it. The Rust `kition_kdm::diff::diff_states` answers the same for the same states.
 */
import { compareKeys } from './canonical'

/** One object in a `StateDiff`: its id, its type, and the fields concerned (sorted). */
export type ObjectChange = { id: string; type: string; fields: string[] }

/** A text-like field (a `text` field, or a string) a draft changed, as plain text before and after. */
export type TextChange = { id: string; field: string; before: string; after: string }

/**
 * What changed between two canonical states, each list sorted by object id (then field):
 * `created` objects only `after` has (`fields`: those holding a value, not null or empty),
 * `changed` objects whose fields differ (`fields`: the differing ones), `deleted` objects only
 * `before` has, and `texts`, the text-like fields of created and changed objects whose text differs.
 */
export type StateDiff = { created: ObjectChange[]; changed: ObjectChange[]; deleted: ObjectChange[]; texts: TextChange[] }

const TYPE_KEY = '$type'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function objects(state: unknown): Json {
  const found = isObject(state) ? state.objects : undefined
  return isObject(found) ? found : {}
}

const typeOf = (object: unknown): string => (isObject(object) && typeof object[TYPE_KEY] === 'string' ? (object[TYPE_KEY] as string) : '')

function fieldsOf(object: unknown): Json {
  const fields: Json = isObject(object) ? { ...object } : {}
  delete fields[TYPE_KEY]
  return fields
}

function holdsValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0
  if (isObject(value)) return Object.keys(value).length > 0
  return true
}

/** A field's text: a string, or a marked text's runs (`[{ insert, attributes? }]`) joined. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0 && value.every((run) => isObject(run) && typeof run.insert === 'string')) {
    return value.map((run) => (run as { insert: string }).insert).join('')
  }
  return null
}

/** Canonical states compare by their text (keys are already sorted in both). */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const sortedKeys = (...maps: Json[]): string[] => [...new Set(maps.flatMap((map) => Object.keys(map)))].sort(compareKeys)

/** The difference `before → after` of two canonical states (`Replica.stateJson`). */
export function diffStates(before: unknown, after: unknown): StateDiff {
  const [old, next] = [objects(before), objects(after)]
  const diff: StateDiff = { created: [], changed: [], deleted: [], texts: [] }
  for (const id of sortedKeys(old, next)) {
    const was = old[id]
    const now = next[id]
    if (was === undefined && now !== undefined) {
      const fields = fieldsOf(now)
      const held = sortedKeys(fields).filter((name) => holdsValue(fields[name]))
      for (const name of held) {
        const text = textOf(fields[name])
        if (text) diff.texts.push({ id, field: name, before: '', after: text })
      }
      diff.created.push({ id, type: typeOf(now), fields: held })
    } else if (was !== undefined && now === undefined) {
      diff.deleted.push({ id, type: typeOf(was), fields: [] })
    } else if (!same(was, now)) {
      const [wasFields, nowFields] = [fieldsOf(was), fieldsOf(now)]
      const fields: string[] = []
      for (const name of sortedKeys(wasFields, nowFields)) {
        const a = wasFields[name] ?? null
        const b = nowFields[name] ?? null
        if (same(a, b)) continue
        fields.push(name)
        const text = (value: unknown) => (value === null ? '' : textOf(value))
        const [textBefore, textAfter] = [text(a), text(b)]
        if (textBefore !== null && textAfter !== null && textBefore !== textAfter) diff.texts.push({ id, field: name, before: textBefore, after: textAfter })
      }
      diff.changed.push({ id, type: typeOf(now) || typeOf(was), fields })
    }
  }
  return diff
}

/** Whether a `StateDiff` holds no object change. */
export const diffIsEmpty = (diff: StateDiff): boolean => !diff.created.length && !diff.changed.length && !diff.deleted.length
