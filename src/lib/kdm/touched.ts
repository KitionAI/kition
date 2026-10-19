// Copied from kition-sdk packages/kdm/src/touched.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Which objects a change touches, read from the KDM format alone (no schema, no kit), as a sync
 * server checks a `commenter`'s push (sync protocol 1.6, Kit Standard 2.0 rule M23): an operation
 * targets an object when it is the object's entry in the `objects` map or lands in a container
 * inside that object; anything else (`meta`, the schema raises) touches the document itself.
 */
import { isContainer as isEngineContainer, LoroDoc, LoroMap, type LoroEventBatch } from 'loro-crdt'
import { open, Version } from './envelope'
import { errors } from './errors'
import type { ObjectId } from './ids'
import { isCommentType } from './comment'
import * as read from './read'

/** What a change touched: each object with its type (as it was before, else after), and whether it changed the document outside its objects. */
export type Touched = { objects: Map<ObjectId, string | null>; outside: boolean }

/** Whether `touched` holds only comment threads and comments: all a commenter may write (rule M23). */
export function touchesOnlyComments(touched: Touched): boolean {
  if (touched.outside) return false
  for (const type of touched.objects.values()) if (type === null || !isCommentType(type)) return false
  return true
}

const engineMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function typeIn(doc: LoroDoc, id: ObjectId): string | null {
  const map = doc.getMap(read.OBJECTS).get(id)
  if (!(map instanceof LoroMap)) return null
  const type = map.get(read.TYPE_KEY)
  return typeof type === 'string' ? type : null
}

/**
 * A copy of a document that follows its changes and tells what each one touched. It reads the
 * KDM layout only, so it serves any kit's document; it never writes.
 */
export class ChangeAudit {
  private constructor(private readonly doc: LoroDoc) {}

  /** From a snapshot or a full change export of the document. */
  static load(bytes: Uint8Array): ChangeAudit {
    const doc = new LoroDoc()
    try {
      doc.import(open(bytes).engine)
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    return new ChangeAudit(doc)
  }

  version(): Version {
    return Version.fromEngine(this.doc.oplogVersion())
  }

  /** Takes changes the document already holds without looking at them (another replica's, an undo). */
  follow(changes: Uint8Array): void {
    try {
      this.doc.import(open(changes).engine)
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
  }

  /** Takes `changes` and answers what they touched. */
  touched(changes: Uint8Array): Touched {
    const engine = open(changes).engine
    const before = this.doc.oplogFrontiers()
    const ids = new Set<ObjectId>()
    let outside = false
    const unsubscribe = this.doc.subscribe((batch: LoroEventBatch) => {
      for (const event of batch.events) {
        if (event.path[0] !== read.OBJECTS) outside = true
        else if (event.path.length >= 2) ids.add(String(event.path[1]))
        else if (event.diff.type === 'map') for (const key of Object.keys(event.diff.updated)) ids.add(key)
        else outside = true
      }
    })
    try {
      this.doc.import(engine)
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    } finally {
      unsubscribe()
    }
    const objects = new Map<ObjectId, string | null>()
    if (!ids.size) return { objects, outside }
    // The type as it was before the change (an object it deleted has none after), else after.
    const after = new Map([...ids].map((id) => [id, typeIn(this.doc, id)]))
    this.doc.checkout(before)
    try {
      for (const id of ids) objects.set(id, typeIn(this.doc, id) ?? after.get(id) ?? null)
    } finally {
      this.doc.checkoutToLatest()
    }
    // An object's entry whose value is no object map (a stray register) is no object either.
    for (const id of ids) {
      const entry = this.doc.getMap(read.OBJECTS).get(id)
      if (entry !== undefined && !isEngineContainer(entry)) objects.set(id, null)
    }
    return { objects, outside }
  }
}
