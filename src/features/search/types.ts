// src/features/search/types.ts

export type IndexableDoc = {
  id: string
  kind: 'note' | 'table_record' | 'table_meta'
  vaultPath: string
  title: string
  body: string
  tags: string[]
  anchor: NoteAnchor | RecordAnchor | MetaAnchor
}

export type NoteAnchor = {
  kind: 'note'
  line: number
  ch: number
  blockId?: string
  section?: string
}

export type RecordAnchor = {
  kind: 'record'
  tableId: string
  recordId: string
  fieldId?: string
}

export type MetaAnchor = {
  kind: 'meta'
  tableId: string
  metaKind: 'table' | 'field' | 'view'
  metaId: string
}

export type OpName =
  | 'file' | 'path' | 'tag'
  | 'section' | 'block' | 'line'
  | 'task' | 'task-todo' | 'task-done'
  | 'table' | 'field' | 'view'
  | 'regex' | 'match-case'

export type QueryNode =
  | { kind: 'term';   value: string }
  | { kind: 'phrase'; value: string }
  | { kind: 'field';  op: Exclude<OpName, 'line' | 'regex' | 'match-case'>; value: string }
  | { kind: 'range';  op: 'line'; from: number; to: number }
  | { kind: 'regex';  source: string; flags: string }

export type QueryAST = {
  must: QueryNode[]
  mustNot: QueryNode[]
  flags: { matchCase: boolean }
}

export type SearchHit = {
  id: string
  score: number
  doc: IndexableDoc
  /** byte ranges in doc.body that matched (for snippet rendering) */
  matches: Array<{ start: number; end: number }>
}

export type WorkerProgress = {
  type: 'progress'
  phase: 'note' | 'table' | 'persist'
  done: number
  total: number
}

export type WorkerInbound =
  | { type: 'init';              requestId: string; rootPath: string; rootHash: string }
  | { type: 'bulkLoad';          requestId: string; docs: IndexableDoc[]; isFinal: boolean }
  /** `stamps`: the source files these docs were read from, at the stamp they were read at (table files). */
  | { type: 'upsert';            requestId: string; docs: IndexableDoc[]; stamps?: Record<string, string> }
  | { type: 'remove';            requestId: string; ids: string[] }
  | { type: 'removeByVaultPath'; requestId: string; vaultPaths: string[] }
  | { type: 'query';             requestId: string; ast: QueryAST; limit: number }
  | { type: 'destroy';           requestId: string }

export type WorkerOutbound =
  /** `stamps`: each indexed table file's stamp when it was read, from the restored snapshot. */
  | { type: 'ready';   requestId: string; restoredFromDisk: boolean; docCount: number; stamps: Record<string, string> }
  | WorkerProgress
  | { type: 'results'; requestId: string; hits: SearchHit[]; truncated: boolean }
  | { type: 'ack';     requestId: string }
  | { type: 'error';   requestId: string; message: string; recoverable: boolean }
