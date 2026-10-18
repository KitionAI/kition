/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/table-changed.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

import type { DataDocumentsTransactTableChange } from './data-documents-transact'

/**
 * The transact/undo/redo TableChange (data-documents-transact.schema.json) plus the document's workspace-relative path.
 */
export type TableChangedParams = (DataDocumentsTransactTableChange) & ({
  /**
   * Workspace-relative .kitable path.
   */
  documentPath: string
})

/**
 * table/changed: a notification the runtime sends on the kit bridge stream (GET /v1/kits/bridge) after a data-document transaction, undo, redo, or dashboard write lands, including ones this window made itself. A window ignores events whose change.origin is its own person:session:<uuid>, since it already applied that edit locally.
 */
export type TableChangedContract = TableChangedParams
