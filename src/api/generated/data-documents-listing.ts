/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/data-documents-listing.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type DataDocumentsListingDocument = {
  id: number
  /**
   * Workspace-relative, slash-separated .kitable path.
   */
  path: string
  title: string
  workspace_root?: string
}

/**
 * GET /api/v1/data-documents?workspace_root=<root>. With the capability, the workspace file system is the source of truth: the runtime indexes every .kitable under the root that has no index row yet, and omits file-backed rows whose file is gone (their rows are kept so a restored file keeps its id). Hidden folders, dependency folders, and symlinks are not scanned. Without workspace_root the plain index answers. Clients must keep their own registration fallback until the capability is advertised.
 */
export type DataDocumentsListingContract = {
  items: DataDocumentsListingDocument[]
  total: number
}
