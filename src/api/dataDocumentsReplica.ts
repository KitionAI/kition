/**
 * A `.kitable` file's KDM replica for co-editing
 * (`contracts/runtime/data-documents-replica.schema.json`): its version, the changes since a
 * version, and importing changes another copy of the document made. Documents are named by
 * their workspace-relative path; bytes travel as standard base64.
 */
import request from './request'
import type {
  DataDocumentsReplicaExportRequest,
  DataDocumentsReplicaExportResponse,
  DataDocumentsReplicaImportRequest,
  DataDocumentsReplicaImportResponse,
  DataDocumentsReplicaVersionRequest,
  DataDocumentsReplicaVersionResponse,
} from './generated/data-documents-replica'

const OPTIONS = { suppressErrorMessage: true, timeout: 10 * 60_000 }

export function getTableReplicaVersion(payload: DataDocumentsReplicaVersionRequest) {
  return request.post<DataDocumentsReplicaVersionResponse>('/v1/data-documents/replica/version', payload, OPTIONS)
}

export function exportTableReplica(payload: DataDocumentsReplicaExportRequest) {
  return request.post<DataDocumentsReplicaExportResponse>('/v1/data-documents/replica/export', payload, OPTIONS)
}

export function importTableReplica(payload: DataDocumentsReplicaImportRequest) {
  return request.post<DataDocumentsReplicaImportResponse>('/v1/data-documents/replica/import', payload, OPTIONS)
}
