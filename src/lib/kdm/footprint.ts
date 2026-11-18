// Copied from kition-sdk packages/kdm/src/footprint.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * A change set's `footprint`, as kition-kdm's `footprint.rs`: a shift of many objects
 * stated once. When at least `FOOTPRINT_MIN_RUN` objects one after another in one list had one
 * numeric field changed by the same amount and nothing else changed in them, their entries are
 * replaced by `{ parent, field, from, count, shift: { field, by } }` (`from` and `count`: the run's
 * indexes in the list after the change). A parent's entry that says only that its list changed
 * (`fields: ["clips"]`, no edits) is dropped when the footprint, or a created, deleted or moved
 * object of that list, already says what happened. Objects whose every change is a shift, the same
 * shifts for at least `FOOTPRINT_MIN_RUN` of them, in no such run are stated by their ids
 *: `{ ids, edits: [{ field, by }] }`. `shift.by` is a number (whole when both values
 * are), or for whole numbers written as strings a string. Both answer the same for
 * `crates/kition-kdm/tests/fixtures/footprint.json`.
 */

import { canonicalText, compareKeys } from './canonical'

type Json = Record<string, unknown>

/** The fewest objects one footprint entry stands for. */
export const FOOTPRINT_MIN_RUN = 4

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const itemsOf = (changes: Json, list: string): Json[] => (Array.isArray(changes[list]) ? (changes[list] as unknown[]).filter(isRecord) : [])
const placeOf = (position: unknown): [string, string] | null =>
  isRecord(position) && typeof position.parent === 'string' && typeof position.field === 'string' ? [position.parent, position.field] : null
const key = (parent: string, field: string) => JSON.stringify([parent, field])

/** The lists a change set changed, which its footprint may name, each once, in order (as the Rust `footprint::lists`). */
export function footprintLists(changes: Json): Array<[string, string]> {
  const found = new Map<string, [string, string]>()
  const add = (place: [string, string] | null) => {
    if (place) found.set(key(...place), place)
  }
  for (const item of [...itemsOf(changes, 'created'), ...itemsOf(changes, 'deleted')]) add(placeOf(item.at))
  for (const item of itemsOf(changes, 'moved')) {
    add(placeOf(item.from))
    add(placeOf(item.to))
  }
  for (const item of itemsOf(changes, 'changed')) {
    if (!Array.isArray(item.edits) || item.edits.length > 0 || typeof item.id !== 'string') continue
    for (const field of Array.isArray(item.fields) ? item.fields : []) if (typeof field === 'string') add([item.id, field])
  }
  return [...found.values()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
}

/** `after - before` as the footprint states it; `null` for values that are no numbers. */
function shift(before: unknown, after: unknown): number | string | null {
  if (typeof before === 'number' && typeof after === 'number') {
    const by = after - before
    return Number.isFinite(by) ? by : null
  }
  const whole = (value: unknown): bigint | null => (typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null)
  const [was, now] = [whole(before), whole(after)]
  return was === null || now === null ? null : (now - was).toString()
}

/** `changes` with its footprint (as the Rust `footprint::with_footprint`); `itemsOf` answers a list's items after the change. */
export function withFootprint(changes: Json, itemsOfList: (parent: string, field: string) => string[] | null): Json {
  const out: Json = JSON.parse(JSON.stringify(changes))
  const placed = new Set(['created', 'deleted', 'moved'].flatMap((list) => itemsOf(changes, list)).map((item) => item.id))
  const shifted = new Map<string, string>()
  const shifts = new Map<string, [string, number | string]>()
  // Each changed object whose every change is a shift: its shifts, by field.
  const shiftsOf: Array<[string, Array<[string, number | string]>]> = []
  for (const item of itemsOf(changes, 'changed')) {
    const edits = Array.isArray(item.edits) ? item.edits : []
    if (typeof item.id !== 'string' || placed.has(item.id) || edits.length === 0) continue
    const all: Array<[string, number | string]> = []
    for (const edit of edits) {
      if (!isRecord(edit) || typeof edit.field !== 'string') break
      const by = shift(edit.before, edit.after)
      if (by === null) break
      all.push([edit.field, by])
    }
    const fields = Array.isArray(item.fields) ? item.fields : []
    if (all.length !== edits.length || fields.length !== all.length || !all.every(([field]) => fields.includes(field))) continue
    all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    if (all.length === 1) {
      shifted.set(item.id, JSON.stringify(all[0]))
      shifts.set(item.id, all[0])
    }
    shiftsOf.push([item.id, all])
  }
  const footprint: Json[] = []
  const covered = new Set<string>()
  const lists = footprintLists(changes)
  if (shifted.size >= FOOTPRINT_MIN_RUN) {
    for (const [parent, field] of lists) {
      const listed = itemsOfList(parent, field)
      if (!listed) continue
      let index = 0
      while (index < listed.length) {
        const run = shifted.get(listed[index])
        if (run === undefined) {
          index += 1
          continue
        }
        let end = index + 1
        while (end < listed.length && shifted.get(listed[end]) === run) end += 1
        if (end - index >= FOOTPRINT_MIN_RUN) {
          const [shiftedField, by] = shifts.get(listed[index]) as [string, number | string]
          footprint.push({ parent, field, from: index, count: end - index, shift: { field: shiftedField, by } })
          for (const id of listed.slice(index, end)) covered.add(id)
        }
        index = end
      }
    }
  }
  // The rest, the same shifts for at least FOOTPRINT_MIN_RUN objects: by their ids.
  const groups: Array<[string, Array<[string, number | string]>, string[]]> = []
  for (const [id, all] of shiftsOf) {
    if (covered.has(id)) continue
    const signature = JSON.stringify(all)
    const group = groups.find(([known]) => known === signature)
    if (group) group[2].push(id)
    else groups.push([signature, all, [id]])
  }
  for (const [, all, ids] of groups) {
    if (ids.length < FOOTPRINT_MIN_RUN) continue
    footprint.push({ ids, edits: all.map(([field, by]) => ({ field, by })) })
    for (const id of ids) covered.add(id)
  }
  const assignments = new Map<string, { edits: Json[]; ids: string[] }>()
  for (const item of itemsOf(changes, 'changed')) {
    if (typeof item.id !== 'string' || covered.has(item.id) || placed.has(item.id)) continue
    if (!Array.isArray(item.edits) || item.edits.length === 0 || !Array.isArray(item.fields)) continue
    const edits: Json[] = []
    for (const edit of item.edits) {
      if (!isRecord(edit) || typeof edit.field !== 'string' || !Object.hasOwn(edit, 'after')) break
      const value = edit.after
      if (isRecord(value) && ('excerpt' in value || Object.keys(value).length === 1 && 'size' in value)) break
      edits.push({field:edit.field,after:value})
    }
    if (edits.length !== item.edits.length || item.fields.length !== edits.length || !edits.every(edit => (item.fields as unknown[]).includes(edit.field))) continue
    edits.sort((a,b) => compareKeys(a.field as string,b.field as string))
    const signature = canonicalText(edits)
    const group = assignments.get(signature)
    if (group) group.ids.push(item.id)
    else assignments.set(signature,{edits,ids:[item.id]})
  }
  for (const {edits,ids} of assignments.values()) {
    if (ids.length < FOOTPRINT_MIN_RUN) continue
    footprint.push({ids,edits})
    for (const id of ids) covered.add(id)
  }
  const told = new Set(
    footprint.filter((print) => typeof print.parent === 'string').map((print) => key(print.parent as string, print.field as string)),
  )
  const tell = (place: [string, string] | null) => {
    if (place) told.add(key(...place))
  }
  for (const item of [...itemsOf(changes, 'created'), ...itemsOf(changes, 'deleted')]) tell(placeOf(item.at))
  for (const item of itemsOf(changes, 'moved')) {
    tell(placeOf(item.from))
    tell(placeOf(item.to))
  }
  if (Array.isArray(out.changed)) {
    out.changed = (out.changed as unknown[]).filter((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return true
      if (covered.has(item.id)) return false
      if (!Array.isArray(item.edits) || item.edits.length > 0 || !Array.isArray(item.fields)) return true
      const id = item.id
      item.fields = item.fields.filter((field) => typeof field !== 'string' || !told.has(key(id, field)))
      return (item.fields as unknown[]).length > 0
    })
  }
  if (footprint.length > 0) out.footprint = footprint
  return memberShifts(out)
}

function numericLeaves(path:string,before:unknown,after:unknown,out:Json[],maps:Set<string>):boolean {
  if(JSON.stringify(before)===JSON.stringify(after)) return true
  if(isRecord(before)&&isRecord(after)) {
    const keys=Object.keys(before).sort(compareKeys)
    if(keys.some(key=>!key||key.includes('.')||key.includes('*'))||JSON.stringify(keys)!==JSON.stringify(Object.keys(after).sort(compareKeys))) return false
    maps.add(path)
    return keys.every(key=>numericLeaves(`${path}.${key}`,before[key],after[key],out,maps))
  }
  if(Array.isArray(before)&&Array.isArray(after)) {
    if(before.length!==after.length) return false
    return before.every((value,index)=>numericLeaves(`${path}.${index}`,value,after[index],out,maps))
  }
  if(shift(before,after)===null) return false
  out.push({field:path,before,after})
  return true
}

function memberShifts(out:Json):Json {
  for(const object of itemsOf(out,'changed')) {
    const original=Array.isArray(object.edits)?object.edits.filter(isRecord):[]
    const edits:Json[]=[]
    const maps=new Set<string>()
    for(const edit of original) {
      const leaves:Json[]=[]
      if(typeof edit.field==='string'&&(isRecord(edit.before)||Array.isArray(edit.before))&&numericLeaves(edit.field,edit.before,edit.after,leaves,maps)) edits.push(...leaves)
      else edits.push(edit)
    }
    const groups=new Map<string,{field:string;by:number|string;members:Array<[number,string]>}>()
    edits.forEach((edit,index)=>{
      const by=shift(edit.before,edit.after)
      if(by===null||typeof edit.field!=='string') return
      const segments=edit.field.split('.')
      for(let at=1;at<segments.length-1;at++) {
        if(/^\d+$/.test(segments[at])&&!maps.has(segments.slice(0,at).join('.'))) continue
        const pattern=segments.map((value,index)=>index===at?'*':value).join('.')
        const key=JSON.stringify([pattern,by]),group=groups.get(key)??{field:pattern,by,members:[]}
        group.members.push([index,segments[at]])
        groups.set(key,group)
      }
    })
    const covered=new Set<number>(),prints:Json[]=[]
    for(const group of [...groups.values()].sort((a,b)=>a.field<b.field?-1:a.field>b.field?1:JSON.stringify(a.by)<JSON.stringify(b.by)?-1:1)) {
      const members=group.members.filter(([index])=>!covered.has(index)),keys=[...new Set(members.map(([,key])=>key))].sort(compareKeys)
      if(keys.length<FOOTPRINT_MIN_RUN||keys.length!==members.length) continue
      prints.push({field:group.field,count:keys.length,keys,shift:{by:group.by}})
      members.forEach(([index])=>covered.add(index))
    }
    if(!prints.length) continue
    object.edits=[...edits.filter((_,index)=>!covered.has(index)),...prints]
    object.fields=[...new Set((object.edits as Json[]).map(edit=>edit.field))].sort()
  }
  return out
}
