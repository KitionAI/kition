// src/features/search/types.ts

export type IndexableDoc = {
  id: string
  kind: 'note' | 'kitable_record' | 'kitable_meta'
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
  | 'kitable' | 'field' | 'view'
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
  phase: 'note' | 'kitable' | 'persist'
  done: number
  total: number
}

export type WorkerInbound =
  | { type: 'init';              requestId: string; rootPath: string; rootHash: string }
  | { type: 'bulkLoad';          requestId: string; docs: IndexableDoc[]; isFinal: boolean }
  | { type: 'upsert';            requestId: string; docs: IndexableDoc[] }
  | { type: 'remove';            requestId: string; ids: string[] }
  | { type: 'removeByVaultPath'; requestId: string; vaultPaths: string[] }
  | { type: 'query';             requestId: string; ast: QueryAST; limit: number }
  | { type: 'destroy';           requestId: string }

export type WorkerOutbound =
  | { type: 'ready';   requestId: string; restoredFromDisk: boolean; docCount: number }
  | WorkerProgress
  | { type: 'results'; requestId: string; hits: SearchHit[]; truncated: boolean }
  | { type: 'ack';     requestId: string }
  | { type: 'error';   requestId: string; message: string; recoverable: boolean }
