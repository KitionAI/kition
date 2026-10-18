/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/data-documents-replica.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

import type { DataDocumentsTransactTableChange } from './data-documents-transact'

/**
 * Standard base64; the empty string is no bytes.
 */
export type DataDocumentsReplicaBytes = string

export type DataDocumentsReplicaVersionRequest = {
  /**
   * Workspace-relative .kitable path.
   */
  path: string
  /**
   * The workspace the path is in; the runtime's when blank.
   */
  workspace_root?: string
}

export type DataDocumentsReplicaExportRequest = {
  /**
   * Workspace-relative .kitable path.
   */
  path: string
  /**
   * The workspace the path is in; the runtime's when blank.
   */
  workspace_root?: string
  /**
   * The version the caller holds; blank or missing exports every change.
   */
  since?: DataDocumentsReplicaBytes
}

export type DataDocumentsReplicaImportRequest = {
  /**
   * Workspace-relative .kitable path.
   */
  path: string
  /**
   * The workspace the path is in; the runtime's when blank.
   */
  workspace_root?: string
  /**
   * Changes another replica of the same document exported; must not be empty.
   */
  changes: DataDocumentsReplicaBytes
  /**
   * A blob section of the blobs the changes name (what the export answered, or what the relay fetched); blank for none. Each blob must hash to its name (400).
   */
  blobs?: DataDocumentsReplicaBytes
}

export type DataDocumentsReplicaCreateRequest = {
  /**
   * Workspace-relative path of the new .kitable file; nothing may exist there yet (409).
   */
  path: string
  /**
   * The workspace the path is in; the runtime's when blank.
   */
  workspace_root?: string
  /**
   * A full export (replica/export from nothing) of another copy of the document: the new file holds that same document (same docId), with no undo steps. The answer is a versionResponse.
   */
  changes: DataDocumentsReplicaBytes
  /**
   * A blob section of the blobs the changes name; blank for none.
   */
  blobs?: DataDocumentsReplicaBytes
}

export type DataDocumentsReplicaVersionResponse = {
  /**
   * The data document's id, as in table/changed.
   */
  documentId: string
  /**
   * Workspace-relative .kitable path.
   */
  documentPath: string
  /**
   * The KDM document id: the same in every copy of the document, so it names its sync room.
   */
  docId: string
  /**
   * The replica's version after the request.
   */
  version: DataDocumentsReplicaBytes
}

export type DataDocumentsReplicaExportResponse = {
  documentId: string
  documentPath: string
  docId: string
  /**
   * The version the export brings a replica at since up to.
   */
  version: DataDocumentsReplicaBytes
  /**
   * The changes a replica at since lacks.
   */
  changes: DataDocumentsReplicaBytes
  /**
   * A blob section of the blobs this file holds that the changes name; blank when they name none.
   */
  blobs?: DataDocumentsReplicaBytes
}

export type DataDocumentsReplicaImportResponse = {
  documentId: string
  documentPath: string
  docId: string
  /**
   * The replica's version after the import.
   */
  version: DataDocumentsReplicaBytes
  /**
   * What the import projected, with origin import:sync; empty when every change was known already.
   */
  change: DataDocumentsTransactTableChange
}

/**
 * table/replica-changed params.
 */
export type DataDocumentsReplicaReplicaChanged = {
  /**
   * Workspace-relative .kitable path.
   */
  documentPath: string
  docId: string
  /**
   * The replica's new version.
   */
  version: DataDocumentsReplicaBytes
}

/**
 * A .kitable file's KDM replica for co-editing: POST /v1/data-documents/replica/version, POST /v1/data-documents/replica/export, POST /v1/data-documents/replica/import, and POST /v1/data-documents/replica/create (a new file from another copy's full export, answered like version), each naming the document by its workspace-relative path; and the table/replica-changed notification on the kit bridge stream (GET /v1/kits/bridge), sent after every local transaction (any origin but import) moves a file's replica to a new version. Bytes (versions, changes, and blob sections) are standard base64. Attachments the file holds as blobs travel beside the changes as a blob section, (64-hex SHA-256 as ASCII, u64 little-endian length, bytes)*: an export answers the blobs its changes name, and an import or create stores the blobs it is given before the changes. An import has the origin import:sync: it is no undo step, it is stored and projected like any write, and it is published as table/changed (table-changed.schema.json) when it changed anything.
 */
export type DataDocumentsReplicaContract = DataDocumentsReplicaVersionResponse
