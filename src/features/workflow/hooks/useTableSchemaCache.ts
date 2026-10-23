import { useCallback, useRef, useState } from 'react'

import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { tableKey } from '@/api/kitTables'
import { fetchWorkflowTableSchema } from '@/features/workflow/lib/workflowTableSchema'

/**
 * useTableSchemaCache — owns the lazy schemaByTableId map and exposes
 * one `ensure(documentPath, tableId, tableName?)` entry point. The map is
 * keyed by `tableKey(documentPath, tableId)` (table ids repeat across files).
 *
 * Extracted from WorkflowHomePage (WF-C1j3). Two effects (trigger
 * schema, add_record target schema) and one async handler (the
 * dangling field-ref pre-check in commitTriggerTableSwap) used to
 * juggle the cache directly with setSchemaByTableId. Folding the
 * cache management here turns three call sites into one.
 *
 * Semantics:
 *   - `schemas[tableKey(path, tableId)]` is undefined until the first `ensure` finishes.
 *   - `ensure` short-circuits on a cache hit and returns the cached
 *     schema synchronously (well, as a resolved promise) — callers can
 *     always `await` without branching.
 *   - In-flight fetches are de-duped: two `ensure` calls on the same
 *     uncached table share one network round-trip.
 *   - Fetch errors silently resolve to `null` so callers can `?.fields`
 *     into the result without try/catch; the page degrades gracefully
 *     (the body editor renders "missing field" warnings rather than
 *     dead-ending).
 *   - Stale-write safety: when a fetch resolves after the page has moved
 *     on to a different workflow, the result still slots into the cache
 *     correctly because the cache is keyed by table, not by which
 *     workflow asked for it. So no cancellation token is needed.
 */
export interface UseTableSchemaCacheResult {
  schemas: Record<string, TableSchema>
  ensure: (documentPath: string, tableId: string, tableName?: string) => Promise<TableSchema | null>
}

export function useTableSchemaCache(): UseTableSchemaCacheResult {
  const [schemas, setSchemas] = useState<Record<string, TableSchema>>({})
  // schemasRef mirrors the state so `ensure` can synchronously check
  // for a cache hit without going through the React render cycle.
  // Without this, two concurrent ensure() calls could both miss the
  // cache, both kick off a fetch, and one would clobber the other in
  // setSchemas (harmless but wasteful network).
  const schemasRef = useRef<Record<string, TableSchema>>({})
  // In-flight Promise registry: keyed by table so two concurrent
  // ensures on the same uncached id share one fetch.
  const inFlight = useRef<Map<string, Promise<TableSchema | null>>>(new Map())

  const ensure = useCallback(async (documentPath: string, tableId: string, tableName?: string): Promise<TableSchema | null> => {
    const key = tableKey(documentPath, tableId)
    const cached = schemasRef.current[key]
    if (cached) return cached
    const pending = inFlight.current.get(key)
    if (pending) return pending
    const promise = fetchWorkflowTableSchema(documentPath, tableId, tableName || 'Table')
      .then((schema) => {
        schemasRef.current = { ...schemasRef.current, [key]: schema }
        setSchemas(schemasRef.current)
        return schema
      })
      .catch(() => null)
      .finally(() => {
        inFlight.current.delete(key)
      })
    inFlight.current.set(key, promise)
    return promise
  }, [])

  return { schemas, ensure }
}
