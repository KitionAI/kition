// Copied from kition-sdk packages/kdm/src/diff.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The object-level difference between two states of one document (standard 2.0 A13): what a
 * change created, changed, moved, and deleted. One description serves a draft's comparison
 * (`diffStates`, over two canonical states, with the full `texts`) and a write's receipt
 * (`Replica.changesSince`, from the objects a replica changed since a version, values cut to
 * excerpts, no `texts`). The Rust `kition_kdm::diff` answers the same for the same states.
 */
import { canonicalText, compareKeys } from './canonical'
import { fieldDef, type Schema } from './schema'
import { ToolIds } from './toolIds'

/** Where an object sits: the object whose list or tree field holds it (a tree node's parent object, or the tree's owner for a root), that field, and its index among its siblings. */
export type Position = { parent: string; field: string; index: number }

/** One field a change changed: its value before and after, as `shownValue` gives them. */
export type TextSpan = {offset:number;removed:string;inserted:string;removedLength:number;insertedLength:number;before:string;after:string;complete:boolean}
export type FieldEdit = { field: string; before: unknown; after: unknown; named?: string; span?: TextSpan; spansTruncated?: boolean }

/**
 * One object in a `StateDiff`: its id, its type, and the fields concerned (sorted). A created
 * object also gives `values` (list and tree fields left out) and `at`, where a list or tree holds
 * it; a deleted one `at`, where a list or tree held it; a changed one gives `edits`.
 */
export type ObjectChange = { id: string; type: string; fields: string[]; values?: Record<string, unknown>; at?: Position; edits?: FieldEdit[] }

/** An object whose place in a list or tree changed; `from` or `to` is `null` where no changed list holds it. */
export type Move = { id: string; type: string; from: Position | null; to: Position | null }

/** A text-like field (a `text` field, or a string) a draft changed, as plain text before and after. */
export type TextChange = { id: string; field: string; before: string; after: string }

/**
 * What changed between two states, each list sorted by object id (then field): `created` objects
 * only `after` has (`fields`: those holding a value), `changed` objects whose fields differ,
 * `moved` objects whose place in a list or tree changed (also in `changed` when their fields did),
 * `deleted` objects only `before` has (`at`: where a list or tree held them), and `texts`, the full text of changed text-like fields, which
 * only a draft's comparison has. `footprint` states a shift of many objects once
 * (`withFootprint`, which agent tools apply to the change sets they answer); a diff never fills it.
 */
export type StateDiff = {
  created: ObjectChange[]
  changed: ObjectChange[]
  moved: Move[]
  deleted: ObjectChange[]
  texts?: TextChange[]
  footprint?: unknown
}

/** The most characters a text value of a change shows; a longer one is an excerpt with its length. */
export const EXCERPT_CHARS = 80
/** One bounded replacement, in Unicode scalar offsets, matching Rust's `text_span`. */
export function textSpan(before: string, after: string): TextSpan | undefined {
  const a = Array.from(before), b = Array.from(after)
  if (before === after || a.length <= EXCERPT_CHARS) return undefined
  let offset = 0, suffix = 0
  while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++
  while (suffix < Math.min(a.length, b.length) - offset && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const removedLength = a.length - offset - suffix, insertedLength = b.length - offset - suffix
  return {
    offset,
    removed: a.slice(offset, offset + Math.min(removedLength, 80)).join(''),
    inserted: b.slice(offset, offset + Math.min(insertedLength, 80)).join(''),
    removedLength, insertedLength,
    before: a.slice(Math.max(0, offset - 20), offset).join(''),
    after: a.slice(a.length - suffix, a.length - suffix + 20).join(''),
    complete: removedLength <= 80 && insertedLength <= 80,
  }
}

/** Add bounded spans before translating tool ids. At most 64 KiB of span JSON per change. */
export function withTextSpans(diff: StateDiff, before: unknown, after: unknown): StateDiff {
  let bytes = 0
  const value = (state: unknown, id: string, path: string): unknown =>
    path.split('.').reduce<unknown>((at, key) => isObject(at) ? at[key] : Array.isArray(at) ? at[Number(key)] : undefined, objects(state)[id])
  const located = { ...diff, changed: diff.changed.map(object => ({ ...object, edits: object.edits?.map(edit => {
    const old = value(before, object.id, edit.field), now = value(after, object.id, edit.field)
    const a = old == null ? '' : textOf(old), b = now == null ? '' : textOf(now)
    const span = a === null || b === null ? undefined : textSpan(a, b)
    if (!span) return edit
    const size = new TextEncoder().encode(JSON.stringify(span)).length
    if (bytes + size > 65_536) return { ...edit, spansTruncated: true }
    bytes += size
    return { ...edit, span }
  }) })) }
  const gone = goneValues.get(diff)
  if (gone) goneValues.set(located, gone)
  return located
}
const EXCERPT_LEAD = 20
const ELLIPSIS = '…'

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
/** Whether two shown values are equal, whatever the order of their keys. */
const equalValues = (a: unknown, b: unknown): boolean => canonicalText(a) === canonicalText(b)

const sortedKeys = (...maps: Json[]): string[] => [...new Set(maps.flatMap((map) => Object.keys(map)))].sort(compareKeys)

type Shape = 'list' | 'tree' | 'value'

const isTree = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((node) => isObject(node) && typeof node.object === 'string' && Array.isArray(node.children))

const isList = (value: unknown, known: (id: string) => boolean): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && known(item))

const emptyOrNull = (value: unknown): boolean => value === null || value === undefined || (Array.isArray(value) && value.length === 0)

/** As the Rust `shape_of`: a list or tree when one side reads as one and the other as one too or empty. */
function shapeOf(was: unknown, now: unknown, known: (id: string) => boolean): Shape {
  const fits = (test: (value: unknown) => boolean) => (test(was) || test(now)) && (test(was) || emptyOrNull(was)) && (test(now) || emptyOrNull(now))
  if (fits(isTree)) return 'tree'
  if (fits((value) => isList(value, known))) return 'list'
  return 'value'
}

function blobSize(value: unknown): number | null {
  if (!isObject(value) || typeof value.hash !== 'string' || typeof value.mime !== 'string') return null
  return typeof value.size === 'number' && Number.isInteger(value.size) && value.size >= 0 ? value.size : null
}

/** A text as a change shows it: whole up to `EXCERPT_CHARS` characters, else `{ excerpt, length }` from about `start`. */
function shownText(text: string, start: number): unknown {
  const chars = Array.from(text)
  if (chars.length <= EXCERPT_CHARS) return text
  const from = Math.min(Math.max(start - EXCERPT_LEAD, 0), chars.length)
  let budget = EXCERPT_CHARS
  let excerpt = ''
  if (from > 0) {
    excerpt += ELLIPSIS
    budget -= 1
  }
  const rest = chars.slice(from)
  excerpt += rest.length <= budget ? rest.join('') : rest.slice(0, budget - 1).join('') + ELLIPSIS
  return { excerpt, length: chars.length }
}

/** A field's value as a change shows it: a text as an excerpt when long, a blob as `{ size }`, anything else as it is. */
export function shownValue(value: unknown, start: number): unknown {
  const size = blobSize(value)
  if (size !== null) return { size }
  const text = textOf(value)
  return text === null ? value : shownText(text, start)
}

function basisValue(value: unknown, start: number): unknown {
  return blobSize(value) === null ? shownValue(value, start) : value
}

function commonPrefix(a: string, b: string): number {
  const [x, y] = [Array.from(a), Array.from(b)]
  let count = 0
  while (count < x.length && count < y.length && x[count] === y[count]) count += 1
  return count
}

/** A place in a list or tree: owner, field, parent, joined so it compares as the Rust tuple does. */
type Group = [string, string, string]
const groupKey = (group: Group): string => JSON.stringify(group)

class Places {
  readonly at = new Map<string, { group: Group; index: number }>()

  add(owner: string, field: string, value: unknown, shape: Shape): void {
    if (shape === 'list') {
      const group: Group = [owner, field, owner]
      const items = (value as unknown[]).filter((item): item is string => typeof item === 'string')
      items.forEach((item, index) => {
        if (!this.at.has(item)) this.at.set(item, { group, index })
      })
    } else if (shape === 'tree') this.addNodes(owner, field, owner, value)
  }

  private addNodes(owner: string, field: string, parent: string, nodes: unknown): void {
    const group: Group = [owner, field, parent]
    ;(Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
      if (!isObject(node) || typeof node.object !== 'string') return
      if (!this.at.has(node.object)) this.at.set(node.object, { group, index })
      this.addNodes(owner, field, node.object, node.children)
    })
  }

  position(id: string): Position | null {
    const found = this.at.get(id)
    return found ? { parent: found.group[2], field: found.group[1], index: found.index } : null
  }
}

/** The values of each diff's deleted objects, as a created object's are given: what an attributed deletion shows as `before` (the Rust `StateDiff::gone`). */
const goneValues = new WeakMap<StateDiff, Map<string, Json>>()

/** Private journal values for historical coverage; never include these in public receipts. */
export function withDeletedBasis(diff: StateDiff, schema: Schema): Omit<StateDiff, 'deleted'> & { deleted: Array<ObjectChange & { $was?: Json }> } {
  const gone = goneValues.get(diff)
  const recorded = { ...diff, deleted: diff.deleted.map(change => {
    const values = gone?.get(change.id)
    const fields = schema.types[change.type]?.fields
    const was = Object.fromEntries(Object.entries(values ?? {}).filter(([field]) => field.startsWith('~') || fields && Object.hasOwn(fields, field)))
    return Object.keys(was).length ? { ...change, $was: was } : { ...change }
  }) }
  if (gone) goneValues.set(recorded, gone)
  return recorded
}

/** As the Rust `longest_increasing`: the indices of a longest strictly increasing subsequence, by patience sorting. */
function longestIncreasing(seq: number[]): Set<number> {
  const tops: number[] = []
  const previous: Array<number | null> = seq.map(() => null)
  seq.forEach((value, at) => {
    let low = 0
    let high = tops.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (seq[tops[middle]] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[at] = tops[low - 1]
    if (low === tops.length) tops.push(at)
    else tops[low] = at
  })
  const kept = new Set<number>()
  let at: number | null = tops.length > 0 ? tops[tops.length - 1] : null
  while (at !== null) {
    kept.add(at)
    at = previous[at]
  }
  return kept
}

/** At most how many edits a `json` value's change is told in, down to its changed leaves (`withLeafEdits`); more, and it is told whole. */
export const LEAF_EDITS = 16

/** Whether a value is what `shownValue` made of a long text or a blob (`{ excerpt, length }`, `{ size }`): a leaf. */
function isShown(value: unknown): boolean {
  if (blobSize(value) !== null) return true
  if (!isObject(value)) return false
  const keys = Object.keys(value).sort(compareKeys).join(',')
  return keys === 'excerpt,length' || keys === 'size'
}

const sameValue = (a: unknown, b: unknown): boolean => canonicalText(a) === canonicalText(b)

/** The edits from `a` to `b` at `path`, down to the leaves that differ (as the Rust `leaves`). */
function leaves(path: string, a: unknown, b: unknown, out: FieldEdit[]): void {
  if (isObject(a) && isObject(b) && !isShown(a) && !isShown(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareKeys)
    for (const key of keys) {
      const [p, q] = [a[key] ?? null, b[key] ?? null]
      if (!sameValue(p, q)) leaves(`${path}.${key}`, p, q, out)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((p, index) => {
      if (!sameValue(p, b[index])) leaves(`${path}.${index}`, p, b[index], out)
    })
    return
  }
  out.push({ field: path, before: basisValue(a, 0), after: shownValue(b, 0) })
}

const editsSize = (edits: FieldEdit[]): number => edits.reduce((sum, edit) => sum + edit.field.length + canonicalText(edit.before).length + canonicalText(edit.after).length, 0)

/** A `json` value's change down to its changed leaves when that is at most `LEAF_EDITS` edits and fewer bytes, else whole (as the Rust `finer`). */
function finer(path: string, a: unknown, b: unknown): FieldEdit[] {
  const whole: FieldEdit[] = [{ field: path, before: basisValue(a, 0), after: shownValue(b, 0) }]
  const found: FieldEdit[] = []
  leaves(path, a, b, found)
  return found.length <= LEAF_EDITS && editsSize(found) < editsSize(whole) ? found : whole
}

/** A `map` field's change, one edit per changed key (as the Rust `by_key`). */
function byKey(path: string, a: unknown, b: unknown): FieldEdit[] {
  const x = a === null ? {} : a
  const y = b === null ? {} : b
  if (!isObject(x) || !isObject(y)) return [{ field: path, before: a, after: b }]
  const out: FieldEdit[] = []
  for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort(compareKeys)) {
    const [p, q] = [x[key] ?? null, y[key] ?? null]
    if (!sameValue(p, q)) out.push(...finer(`${path}.${key}`, p, q))
  }
  return out
}

/**
 * As the Rust `StateDiff::with_leaf_edits`: a changed `map` field that owns no objects
 * told by key (`attrs.stretch`), a `json` value and each key's value down to its changed leaves
 * when that is at most `LEAF_EDITS` edits and fewer bytes than the value whole; each edit's path
 * stands in `fields` for the field. Apply it before `diffWithToolIds`.
 */
export function withLeafEdits(diff: StateDiff, schema: Schema): StateDiff {
  for (const change of diff.changed) {
    if (!change.edits) continue
    const split = new Map<string, FieldEdit[]>()
    for (const edit of change.edits) {
      let def
      try {
        def = fieldDef(schema, change.type, edit.field)
      } catch {
        continue
      }
      const told = def.kind === 'map' && !def.owns ? byKey(edit.field, edit.before, edit.after) : def.kind === 'json' ? finer(edit.field, edit.before, edit.after) : null
      if (told && (told.length !== 1 || told[0].field !== edit.field)) split.set(edit.field, told)
    }
    if (split.size === 0) continue
    const edits: FieldEdit[] = []
    let fields = [...change.fields]
    for (const edit of change.edits) {
      const told = split.get(edit.field)
      if (!told) {
        edits.push(edit)
        continue
      }
      fields = fields.filter((field) => field !== edit.field)
      fields.push(...told.map((one) => one.field))
      edits.push(...told)
    }
    change.edits = edits.sort((a, b) => compareKeys(a.field, b.field))
    change.fields = [...new Set(fields)].sort(compareKeys)
  }
  return diff
}

/**
 * As the Rust `diff_objects`: the difference of the objects `ids` (sorted) between two sides, each
 * the canonical objects it has among them; `typeOfId` answers an object's type on either side.
 * @internal
 */
export function diffObjects(ids: string[], old: Json, next: Json, typeOfId: (id: string) => string | null, fullTexts: boolean): StateDiff {
  const known = (id: string) => typeOfId(id) !== null
  const diff: StateDiff = { created: [], changed: [], moved: [], deleted: [] }
  const texts: TextChange[] = []
  const [before, after] = [new Places(), new Places()]
  const createdIds = new Set<string>()
  const deletedIds = new Set<string>()
  const gone = new Map<string, Json>()
  goneValues.set(diff, gone)
  for (const id of ids) {
    const was = Object.hasOwn(old, id) ? old[id] : undefined
    const now = Object.hasOwn(next, id) ? next[id] : undefined
    if (was === undefined && now !== undefined) {
      createdIds.add(id)
      const fields = fieldsOf(now)
      const held = sortedKeys(fields).filter((name) => holdsValue(fields[name]))
      const values: Json = {}
      for (const name of held) {
        const shape = name.startsWith('~') ? 'value' : shapeOf(null, fields[name], known)
        if (shape === 'value') values[name] = shownValue(fields[name], 0)
        else after.add(id, name, fields[name], shape)
        const text = textOf(fields[name])
        if (fullTexts && text) texts.push({ id, field: name, before: '', after: text })
      }
      diff.created.push({ id, type: typeOf(now), fields: held, values })
    } else if (was !== undefined && now === undefined) {
      deletedIds.add(id)
      const fields = fieldsOf(was)
      const values: Json = {}
      for (const name of sortedKeys(fields)) {
        const shape = name.startsWith('~') ? 'value' : shapeOf(fields[name], null, known)
        if (shape === 'value' && holdsValue(fields[name])) values[name] = basisValue(fields[name], 0)
        before.add(id, name, fields[name], shape)
      }
      gone.set(id, values)
      diff.deleted.push({ id, type: typeOf(was), fields: [] })
    } else if (was !== undefined && now !== undefined && !same(was, now)) {
      const [wasFields, nowFields] = [fieldsOf(was), fieldsOf(now)]
      const fields: string[] = []
      const edits: FieldEdit[] = []
      if (typeOf(was) !== typeOf(now)) {
        fields.push('$type')
        edits.push({ field: '$type', before: typeOf(was), after: typeOf(now) })
      }
      for (const name of sortedKeys(wasFields, nowFields)) {
        const a = wasFields[name] ?? null
        const b = nowFields[name] ?? null
        if (same(a, b)) continue
        const shape = name.startsWith('~') ? 'value' : shapeOf(a, b, known)
        if (shape !== 'tree') fields.push(name)
        if (shape !== 'value') {
          before.add(id, name, a, shape)
          after.add(id, name, b, shape)
          continue
        }
        const text = (value: unknown) => (value === null ? '' : textOf(value))
        const [textBefore, textAfter] = [text(a), text(b)]
        let start = 0
        if (textBefore !== null && textAfter !== null) {
          start = commonPrefix(textBefore, textAfter)
          if (fullTexts && textBefore !== textAfter) texts.push({ id, field: name, before: textBefore, after: textAfter })
        }
        edits.push({ field: name, before: basisValue(a, start), after: shownValue(b, start) })
      }
      if (fields.length) diff.changed.push({ id, type: typeOf(now) || typeOf(was), fields, edits })
    }
  }
  for (const change of diff.created) {
    const at = after.position(change.id)
    if (at) change.at = at
  }
  for (const change of diff.deleted) {
    const at = before.position(change.id)
    if (at) change.at = at
  }
  const keptIn = new Map<string, Array<{ id: string; was: number; now: number }>>()
  for (const [id, { group, index }] of after.at) {
    const was = before.at.get(id)
    if (was && groupKey(was.group) === groupKey(group)) {
      const key = groupKey(group)
      if (!keptIn.has(key)) keptIn.set(key, [])
      keptIn.get(key)!.push({ id, was: was.index, now: index })
    }
  }
  const stayed = new Set<string>()
  for (const items of keptIn.values()) {
    items.sort((a, b) => a.now - b.now)
    for (const at of longestIncreasing(items.map((item) => item.was))) stayed.add(items[at].id)
  }
  const placed = [...new Set([...before.at.keys(), ...after.at.keys()])].sort(compareKeys)
  for (const id of placed) {
    if (createdIds.has(id) || deletedIds.has(id) || stayed.has(id)) continue
    diff.moved.push({ id, type: typeOfId(id) ?? '', from: before.position(id), to: after.position(id) })
  }
  if (fullTexts) diff.texts = texts
  return diff
}

/** The difference `before → after` of two canonical states (`Replica.stateJson`): a draft's comparison, with `texts`. */
export function diffStates(before: unknown, after: unknown): StateDiff {
  const [old, next] = [objects(before), objects(after)]
  const typeOfId = (id: string): string | null => (Object.hasOwn(next, id) ? typeOf(next[id]) : Object.hasOwn(old, id) ? typeOf(old[id]) : null)
  return diffObjects(sortedKeys(old, next), old, next, typeOfId, true)
}

/** Private guard history: complete text and marks, capped at 1 MiB per field and 4 MiB total. */
export function withTextBasis(diff: StateDiff, schema: Schema, before: unknown, after: unknown): StateDiff & { $text?: Record<string, Json> } {
  diff = withTextSpans(diff, before, after)
  const old = objects(before), next = objects(after)
  const names = ToolIds.ofState(schema, after)
  const beforeNames = ToolIds.ofState(schema, before)
  const basis: Record<string, Json> = {}
  let bytes = 0
  for (const id of sortedKeys(old, next)) {
    if (!Object.hasOwn(old, id) || !Object.hasOwn(next, id)) continue
    const a = fieldsOf(old[id]), b = fieldsOf(next[id])
    for (const field of sortedKeys(a, b)) {
      if (same(a[field], b[field]) || textOf(a[field]) === null || textOf(b[field]) === null) continue
      const size = new TextEncoder().encode(JSON.stringify(a[field])).length
      if (size > 1_048_576 || bytes + size > 4_194_304) continue
      const held = names.attributed(id)
      const holder = held?.holder ?? names.show(id)
      const path = held ? `${held.path}.${field}` : field
      ;(basis[holder] ??= {})[path] = beforeNames.showText(a[field]) as Json
      bytes += size
    }
  }
  if (!Object.keys(basis).length) return diff
  const recorded = { ...diff, $text: basis }
  const gone = goneValues.get(diff)
  if (gone) goneValues.set(recorded, gone)
  return recorded
}

/** Whether a `StateDiff` holds no object change. */
export const diffIsEmpty = (diff: StateDiff): boolean => !diff.created.length && !diff.changed.length && !diff.moved.length && !diff.deleted.length

/**
 * As the Rust `StateDiff::with_tool_ids`: the difference with objects named as the tool interface
 * names them (rule OM9): created, changed and moved objects by their tool ids in `after`, deleted
 * ones by theirs in `before`; positions' parents (`from` in `before`, `to` and `at` in `after`) and
 * the value of a `ref` field (the id it holds) the same way; each list sorted again by id.
 *
 * An object without a tool id of its own that a nearer object with one holds (`ToolIds.attributed`)
 * is told as an edit of that object at the path from it: a changed field `{ field: '<path>.f',
 * before, after }`; created `{ field: '<path>', before: null, after: <values> }`; deleted `{ field:
 * '<path>', before: <values>, after: null }`; moved `{ field: '<path of its list>', before: '<path
 * before>', after: '<path after>' }` (`null` on the side another holder has); inside an object the
 * same change created, its values join that object's `values` at their paths; inside one it deleted,
 * it is left out. A position whose parent is such an object names its holder and the path to the
 * field, and a ref to one reads `<tool id>.<path>`.
 */
export function diffWithToolIds(diff: StateDiff, schema: Schema, before: ToolIds, after: ToolIds): StateDiff {
  if (!before.isActive() && !after.isActive()) return diff
  const gone = goneValues.get(diff) ?? new Map<string, Json>()
  const show = (names: ToolIds, id: string): string => {
    const held = names.toolId(id) === null ? names.attributed(id) : null
    return held !== null ? `${held.holder}.${held.path}` : names.show(id)
  }
  // A ref's value: the tool id, else `<tool id>.<path>` of a held object, else (an object no tool
  // id names, whose object id a kit may mint again on every read) `{ unnamed: <its type> }`.
  const showValue = (names: ToolIds, value: unknown, of: string | undefined) => {
    if (typeof value !== 'string' || value === '') return value
    if (names.toolId(value) === null && names.attributed(value) === null) return { unnamed: of ?? 'object' }
    return show(names, value)
  }
  const refOf = (ty: string, field: string): string | undefined =>
    Object.hasOwn(schema.types, ty) && Object.hasOwn(schema.types[ty].fields, field) ? (schema.types[ty].fields[field].of ?? undefined) : undefined
  const place = (names: ToolIds, position: Position): Position => {
    const held = names.toolId(position.parent) === null ? names.attributed(position.parent) : null
    return held !== null ? { parent: held.holder, field: `${held.path}.${position.field}`, index: position.index } : { ...position, parent: names.show(position.parent) }
  }
  const types = new Map([...diff.created, ...diff.changed].map((change) => [change.id, change.type]))
  const kindIsRef = (ty: string | undefined, field: string): boolean =>
    ty !== undefined && Object.hasOwn(schema.types, ty) && Object.hasOwn(schema.types[ty].fields, field) && schema.types[ty].fields[field].kind === 'ref'
  const isRef = (id: string, field: string): boolean => kindIsRef(types.get(id), field)
  const nestedRefs = (ty: string, field: string): boolean => ['json', 'map'].includes(schema.types[ty]?.fields[field.split('.')[0]]?.kind ?? '')
  const byId = <T extends { id: string }>(list: T[]) => list.sort((a, b) => compareKeys(a.id, b.id))
  const created: ObjectChange[] = diff.created.map((change) => {
    const shown: ObjectChange = { ...change }
    if (change.values) {
      shown.values = Object.fromEntries(Object.entries(change.values).map(([field, value]) => [field, kindIsRef(change.type, field) ? showValue(after, value, refOf(change.type, field)) : nestedRefs(change.type, field) ? after.showJson(value) : value]))
    }
    if (change.at) shown.at = place(after, change.at)
    return shown
  })
  const changed: ObjectChange[] = diff.changed
    .map((change) => {
      const shown: ObjectChange = { ...change }
      if (change.edits) {
        shown.edits = change.edits.map((edit) =>
          kindIsRef(change.type, edit.field) ? { ...edit, before: showValue(before, edit.before, refOf(change.type, edit.field)), after: showValue(after, edit.after, refOf(change.type, edit.field)) }
            : nestedRefs(change.type, edit.field) ? { ...edit, before: before.showJson(edit.before), after: after.showJson(edit.after) } : edit,
        )
        // A ref to a held object reads as its path (`shape:3.body`): one replaced by another at the
        // same path reads the same, and is told by the held objects' own changes.
        const unchanged = new Set(shown.edits.filter((edit) => kindIsRef(change.type, edit.field) && typeof edit.before === 'string' && equalValues(edit.before, edit.after)).map((edit) => edit.field))
        if (unchanged.size > 0) {
          shown.edits = shown.edits.filter((edit) => !unchanged.has(edit.field))
          shown.fields = shown.fields.filter((field) => !unchanged.has(field))
        }
      }
      return shown
    })
    .filter((change) => change.fields.length > 0)
  // The objects without tool ids their holders tell, taken out of the lists.
  type Told = { type: string; fields: string[]; edits: FieldEdit[]; values: Json }
  const told = new Map<string, Told>()
  const entry = (holder: string, names: ToolIds): Told => {
    const found = told.get(holder) ?? { type: '', fields: [], edits: [], values: {} }
    found.type = names.typeOf(holder) ?? ''
    told.set(holder, found)
    return found
  }
  const createdIds = new Set(diff.created.map((change) => after.show(change.id)))
  const deletedIds = new Set(diff.deleted.map((change) => before.show(change.id)))
  const keptChanged: ObjectChange[] = []
  for (const change of changed) {
    const held = after.attributed(change.id)
    if (held === null) {
      keptChanged.push(change)
      continue
    }
    const { holder, path } = held
    const into = entry(holder, after)
    into.fields.push(...change.fields.map((field) => `${path}.${field}`))
    if (createdIds.has(holder)) {
      for (const edit of change.edits ?? []) into.values[`${path}.${edit.field}`] = edit.after
      continue
    }
    const named = after.namedPath(change.id)
    into.edits.push(...(change.edits ?? []).map((edit) => ({ ...edit, field: `${path}.${edit.field}`, ...(named === null ? {} : { named: `${named}.${edit.field}` }) })))
  }
  const keptCreated: ObjectChange[] = []
  for (const change of created) {
    const held = after.attributed(change.id)
    if (held === null) {
      keptCreated.push(change)
      continue
    }
    const { holder, path } = held
    const into = entry(holder, after)
    const values = change.values ?? {}
    if (createdIds.has(holder)) {
      into.fields.push(...change.fields.map((field) => `${path}.${field}`))
      for (const [field, value] of Object.entries(values)) into.values[`${path}.${field}`] = value
      continue
    }
    into.fields.push(path)
    const named = after.namedPath(change.id)
    into.edits.push({ field: path, before: null, after: values, ...(named === null ? {} : { named }) })
  }
  const keptDeleted: ObjectChange[] = []
  for (const change of diff.deleted) {
    const held = before.attributed(change.id)
    if (held === null) {
      keptDeleted.push({ ...change })
      continue
    }
    if (deletedIds.has(held.holder)) continue
    const into = entry(held.holder, before)
    into.fields.push(held.path)
    const named = before.namedPath(change.id)
    into.edits.push({ field: held.path, before: gone.get(change.id) ?? {}, after: null, ...(named === null ? {} : { named }) })
  }
  const listOf = (path: string): string => {
    const cut = path.lastIndexOf('.')
    return cut >= 0 && /^\d+$/.test(path.slice(cut + 1)) ? path.slice(0, cut) : path
  }
  const keptMoved: Move[] = []
  for (const move of diff.moved) {
    const [from, to] = [before.attributed(move.id), after.attributed(move.id)]
    if (from === null && to === null) {
      keptMoved.push(move)
      continue
    }
    if (from !== null && to !== null && from.holder === to.holder) {
      if (!createdIds.has(to.holder)) {
        const into = entry(to.holder, after)
        into.fields.push(listOf(to.path))
        into.edits.push({ field: listOf(to.path), before: from.path, after: to.path })
      }
      continue
    }
    if (from !== null && !deletedIds.has(from.holder)) {
      const into = entry(from.holder, before)
      into.fields.push(listOf(from.path))
      into.edits.push({ field: listOf(from.path), before: from.path, after: null })
    }
    if (to !== null && !createdIds.has(to.holder)) {
      const into = entry(to.holder, after)
      into.fields.push(listOf(to.path))
      into.edits.push({ field: listOf(to.path), before: null, after: to.path })
    }
  }
  for (const what of told.values()) replacedInPlace(what)
  const out: StateDiff = {
    created: keptCreated.map((change) => ({ ...change, id: after.show(change.id) })),
    changed: keptChanged.map((change) => ({ ...change, id: after.show(change.id) })),
    moved: keptMoved.map((move) => ({ ...move, id: after.show(move.id), from: move.from ? place(before, move.from) : null, to: move.to ? place(after, move.to) : null })),
    deleted: keptDeleted.map((change) => {
      const shown: ObjectChange = { ...change, id: before.show(change.id) }
      if (change.at) shown.at = place(before, change.at)
      return shown
    }),
  }
  const sortedUnique = (fields: string[]) => [...new Set(fields)].sort(compareKeys)
  for (const holder of [...told.keys()].sort(compareKeys)) {
    const what = told.get(holder)!
    const made = out.created.find((change) => change.id === holder)
    if (made !== undefined) {
      made.fields = sortedUnique([...made.fields, ...what.fields])
      made.values = { ...(made.values ?? {}), ...what.values }
      continue
    }
    if (what.fields.length === 0 && what.edits.length === 0) continue
    let change = out.changed.find((known) => known.id === holder)
    if (change === undefined) {
      change = { id: holder, type: what.type, fields: [], edits: [] }
      out.changed.push(change)
    }
    change.fields = sortedUnique([...change.fields, ...what.fields])
    change.edits = [...(change.edits ?? []), ...what.edits].sort((a, b) => compareKeys(a.field, b.field))
  }
  byId(out.created)
  byId(out.changed)
  byId(out.deleted)
  byId(out.moved)
  if (diff.texts) {
    out.texts = diff.texts
      .map((text) => {
        const ref = isRef(text.id, text.field)
        const shown = (names: ToolIds, value: string) => (ref && value !== '' ? show(names, value) : value)
        const held = after.attributed(text.id)
        const [id, field] = held !== null ? [held.holder, `${held.path}.${text.field}`] : [show(after, text.id), text.field]
        return { ...text, id, field, before: shown(before, text.before), after: shown(after, text.after) }
      })
      .sort((a, b) => compareKeys(a.id, b.id) || compareKeys(a.field, b.field))
  }
  if (diff.footprint !== undefined) out.footprint = diff.footprint
  goneValues.set(out, new Map([...gone].map(([id, values]) => {
    const type = before.typeOf(id) ?? ''
    return [before.show(id), Object.fromEntries(Object.entries(values).map(([field, value]) => [field,
      kindIsRef(type, field) ? showValue(before, value, refOf(type, field)) : nestedRefs(type, field) ? before.showJson(value) : value,
    ]))]
  })))
  return out
}

/**
 * As the Rust `Told::replaced_in_place`: an object deleted at a path and another created at the
 * same path (a paragraph replaced, a text body made again) are one object changed there; each of
 * their values that differs is an edit at `<path>.<field>`, and equal values tell nothing.
 */
function replacedInPlace(told: { fields: string[]; edits: FieldEdit[] }): void {
  const created = new Map<string, Json>()
  const deleted = new Map<string, Json>()
  for (const edit of told.edits) {
    if (edit.before === null && isObject(edit.after)) created.set(edit.field, edit.after)
    if (edit.after === null && isObject(edit.before)) deleted.set(edit.field, edit.before)
  }
  const both = new Set([...created.keys()].filter((path) => deleted.has(path)))
  if (both.size === 0) return
  const named = new Map(told.edits.filter((edit) => both.has(edit.field) && edit.named !== undefined).map((edit) => [edit.field, edit.named as string]))
  told.edits = told.edits.filter((edit) => !both.has(edit.field))
  told.fields = told.fields.filter((field) => !both.has(field))
  for (const path of [...both].sort(compareKeys)) {
    const was = deleted.get(path)!
    const now = created.get(path)!
    for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort(compareKeys)) {
      const before = Object.hasOwn(was, name) ? was[name] : null
      const after = Object.hasOwn(now, name) ? now[name] : null
      if (!equalValues(before, after)) {
        told.fields.push(`${path}.${name}`)
        const at = named.get(path)
        told.edits.push({ field: `${path}.${name}`, before, after, ...(at === undefined ? {} : { named: `${at}.${name}` }) })
      }
    }
  }
}
