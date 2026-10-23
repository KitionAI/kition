// Copied from kition-sdk packages/kdm/src/op.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * A transaction's buffered operations and their application to the engine. `Tx` validates each
 * operation when it is called and records it here; nothing reaches the engine until the
 * transaction's function has returned. The engine cannot abort a transaction (its operations take
 * effect as they are applied), so staging is what makes a failed transaction leave no operations.
 */
import { LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree, type TreeID } from 'loro-crdt'
import { errors, KdmError } from './errors'
import { resolveNode, type NodeRef, type ObjectId } from './ids'
import { pendingIndex, treeId, type NodeKey } from './overlay'
import * as read from './read'
import { sortedKeys, type Schema } from './schema'
import type { JsonValue } from './value'

export type JsonFields = Record<string, JsonValue>

export type Op =
  | { op: 'create'; id: ObjectId; ty: string; fields: JsonFields }
  | { op: 'set'; id: ObjectId; field: string; value: JsonValue }
  | { op: 'delete'; id: ObjectId }
  | { op: 'textInsert'; id: ObjectId; field: string; index: number; content: string }
  | { op: 'textDelete'; id: ObjectId; field: string; index: number; count: number }
  /** Sets mark `key` to `value` over `start..end` (UTF-16 code units; never empty). */
  | { op: 'textMark'; id: ObjectId; field: string; start: number; end: number; key: string; value: JsonValue }
  /** Removes mark `key` from `start..end` (never empty). */
  | { op: 'textUnmark'; id: ObjectId; field: string; start: number; end: number; key: string }
  | { op: 'listInsert'; id: ObjectId; field: string; index: number; item: ObjectId }
  | { op: 'listMove'; id: ObjectId; field: string; from: number; to: number }
  | { op: 'listRemove'; id: ObjectId; field: string; index: number }
  | { op: 'mapSet'; id: ObjectId; field: string; key: string; value: JsonValue }
  | { op: 'mapDelete'; id: ObjectId; field: string; key: string }
  /** Creates the transaction's `node`-th node. */
  | { op: 'treeCreate'; id: ObjectId; field: string; parent: NodeKey | null; object: ObjectId; node: number }
  | { op: 'treeMove'; id: ObjectId; field: string; node: NodeKey; parent: NodeKey | null }
  /** Raises the document's minimum schema version (rule M20); a no-op when it is already at least `version` when applied. */
  | { op: 'raiseSchema'; version: number }

/** Applies validated operations in order and resolves the created nodes' handles. Does not commit. */
export function apply(doc: LoroDoc, schema: Schema, ops: Op[], nodes: NodeRef[], touched: (id: ObjectId) => void): void {
  const created: Array<TreeID | undefined> = new Array(nodes.length)
  for (const op of ops) {
    if (op.op !== 'raiseSchema') touched(op.id)
    try {
      applyOne(doc, schema, op, created)
    } catch (error) {
      throw error instanceof KdmError ? error : errors.engine(error instanceof Error ? error.message : String(error))
    }
  }
  nodes.forEach((node, index) => {
    const id = created[index]
    if (id !== undefined) resolveNode(node, id)
  })
}

/**
 * The most UTF-16 code units one engine text element is given by an insert (the Rust crate's
 * `TEXT_PIECE` counts 1024 Unicode scalar values). The engine keeps a text as elements of
 * inserted runs and scans an element holding non-ASCII text on every edit inside it, so an edit
 * costs the length of its element: a file imported in one insert would make every later edit cost
 * the whole file. Longer content goes in pieces, last piece first, so each piece stays its own
 * element (a piece placed before the one inserted just before it is never merged with it). The
 * text and every replica's result are the same; the history holds one insert per piece.
 */
export const TEXT_PIECE = 1024

/** Inserts `content` at `index` in pieces of about {@link TEXT_PIECE} code units, last first, never splitting a surrogate pair. */
function insertInPieces(text: LoroText, index: number, content: string): void {
  if (content.length <= TEXT_PIECE) {
    text.insert(index, content)
    return
  }
  const starts: number[] = []
  for (let at = 0; at < content.length; ) {
    starts.push(at)
    let next = at + TEXT_PIECE
    const unit = content.charCodeAt(next)
    if (next < content.length && unit >= 0xdc00 && unit <= 0xdfff) next += 1
    at = next
  }
  let end = content.length
  for (let piece = starts.length - 1; piece >= 0; piece -= 1) {
    text.insert(index, content.slice(starts[piece], end))
    end = starts[piece]
  }
}

function applyOne(doc: LoroDoc, schema: Schema, op: Op, created: Array<TreeID | undefined>): void {
  switch (op.op) {
    case 'create': {
      const map = doc.getMap(read.OBJECTS).setContainer(op.id, new LoroMap())
      map.set(read.TYPE_KEY, op.ty)
      for (const name of sortedKeys(op.fields)) map.set(name, op.fields[name])
      const fields = schema.types[op.ty].fields
      for (const name of sortedKeys(fields)) {
        const kind = fields[name].kind
        if (kind === 'text') map.setContainer(name, new LoroText())
        else if (kind === 'list') map.setContainer(name, new LoroMovableList())
        else if (kind === 'tree') map.setContainer(name, new LoroTree())
        else if (kind === 'map') map.setContainer(name, new LoroMap())
      }
      return
    }
    case 'set':
      return read.objectMap(doc, op.id).set(op.field, op.value)
    case 'delete':
      return doc.getMap(read.OBJECTS).delete(op.id)
    case 'textInsert':
      return insertInPieces(engineContainer(doc, op.id, op.field, 'text'), op.index, op.content)
    case 'textDelete':
      return engineContainer(doc, op.id, op.field, 'text').delete(op.index, op.count)
    case 'textMark':
      return engineContainer(doc, op.id, op.field, 'text').mark({ start: op.start, end: op.end }, op.key, op.value)
    case 'textUnmark':
      return engineContainer(doc, op.id, op.field, 'text').unmark({ start: op.start, end: op.end }, op.key)
    case 'listInsert':
      return engineContainer(doc, op.id, op.field, 'list').insert(op.index, op.item)
    case 'listMove':
      return engineContainer(doc, op.id, op.field, 'list').move(op.from, op.to)
    case 'listRemove':
      return engineContainer(doc, op.id, op.field, 'list').delete(op.index, 1)
    case 'mapSet':
      return engineContainer(doc, op.id, op.field, 'map').set(op.key, op.value)
    case 'mapDelete':
      return engineContainer(doc, op.id, op.field, 'map').delete(op.key)
    case 'treeCreate': {
      const node = engineContainer(doc, op.id, op.field, 'tree').createNode(nodeId(created, op.parent))
      node.data.set(read.NODE_OBJECT, op.object)
      created[op.node] = node.id
      return
    }
    case 'treeMove': {
      const node = nodeId(created, op.node)
      if (node === undefined) throw errors.engine('a staged tree move has no node')
      return engineContainer(doc, op.id, op.field, 'tree').move(node, nodeId(created, op.parent))
    }
    case 'raiseSchema': {
      const current = read.minSchemaVersion(doc)
      if (current !== null && current >= op.version) return
      // The register is what builds before rule M20 check; the map is what keeps the largest of
      // concurrent raises.
      doc.getMap(read.META).set(read.SCHEMA_VERSION, op.version)
      doc.getMap(read.SCHEMA_RAISES).set(String(op.version), true)
      return
    }
  }
}

/** The container in a field, without schema checks. */
function engineContainer<K extends read.ContainerKind>(doc: LoroDoc, id: ObjectId, field: string, kind: K) {
  const found = read.asContainer(read.objectMap(doc, id).get(field), kind, id, field)
  if (!found) throw errors.notFound(`${id}.${field}`)
  return found
}

/** The engine id of a node key; `undefined` for no node (a root's parent). */
function nodeId(created: Array<TreeID | undefined>, key: NodeKey | null): TreeID | undefined {
  if (key === null) return undefined
  const index = pendingIndex(key)
  if (index === null) return treeId(key)
  const id = created[index]
  if (id === undefined) throw errors.engine(`tree node ${index} is used before it exists`)
  return id
}
