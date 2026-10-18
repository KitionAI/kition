import { runDataAIFieldBatch, runDataAIFieldCell, uploadDataAttachment } from '@/api/dataDocuments'
import { notify } from '@/lib/notify'
import { copyImageToClipboard, resolvePublicFileURL, saveTextFile } from '@/services/desktop'
import { loadMediaModelOptions } from '@/services/mediaModels'
import { requestDesignFromRecord } from '@/services/workspaceDesignActions'
import type { TableHost } from '@/features/table/ports/TableHost'
import { hydrateBundledAIFieldAttachments } from './aiAttachmentHydration'
import { resolveAIConfigRuntimeModel } from './aiRuntimeModel'
import {
  cancelPreparedTableFileImport,
  executePreparedTableFileImport,
  prepareTableFileImport,
} from '@/features/table/lib/tableFileImport'

/** Kition's app services for the table editor: the desktop runtime, its settings and models, and the workspace. */
export const kitionTableHost: TableHost = {
  resolveFileURL: resolvePublicFileURL,
  uploadAttachment: ({ documentId, tableId, file }) => uploadDataAttachment(documentId, tableId, file),
  copyImageToClipboard,
  saveTextFile,
  notify,
  fileImport: {
    prepare: prepareTableFileImport,
    execute: executePreparedTableFileImport,
    cancel: cancelPreparedTableFileImport,
  },
  ai: {
    resolveRuntimeModel: resolveAIConfigRuntimeModel,
    prepareRecord: (params) => hydrateBundledAIFieldAttachments(params),
    runCell: ({ documentId, tableId, recordId, fieldId, ...payload }, options) => (
      runDataAIFieldCell(documentId, tableId, recordId, fieldId, payload, options)
    ),
    runBatch: ({ documentId, tableId, fieldId, ...payload }, options) => (
      runDataAIFieldBatch(documentId, tableId, fieldId, payload, options)
    ),
    loadModelOptions: async (capability) => (
      (await loadMediaModelOptions(capability)).filter((item) => item.source === 'desktop')
    ),
  },
  requestDesignFromRecord,
}
