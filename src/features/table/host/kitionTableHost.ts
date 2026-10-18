import { dataDocumentBlobURL, runDataAIFieldBatch, runDataAIFieldCell, uploadDataAttachment } from '@/api/dataDocuments'
import { getCurrentLocale } from '@/i18n'
import { notify } from '@/lib/notify'
import { copyImageToClipboard, resolvePublicFileURL, saveTextFile } from '@/services/desktop'
import { loadMediaModelOptions } from '@/services/mediaModels'
import { requestDesignFromRecord } from '@/services/workspaceDesignActions'
import type { TableHost } from '@kition/table-editor'
import { hydrateBundledAIFieldAttachments } from './aiAttachmentHydration'
import { resolveAIConfigRuntimeModel } from './aiRuntimeModel'
import {
  cancelPreparedTableFileImport,
  executePreparedTableFileImport,
  prepareTableFileImport,
} from '@/features/table/lib/tableFileImport'

/**
 * Kition's app services for the table editor: the desktop runtime, its settings and models, and the
 * workspace. Members call the services when used, not when this module loads, so a test that mocks
 * one of those modules without them can still import the providers.
 */
export const kitionTableHost: TableHost = {
  resolveFileURL: (url) => resolvePublicFileURL(url),
  resolveBlobURL: ({ documentId, hash }) => dataDocumentBlobURL(documentId, hash),
  uploadAttachment: ({ documentId, tableId, file }) => uploadDataAttachment(documentId, tableId, file),
  copyImageToClipboard: (url) => copyImageToClipboard(url),
  saveTextFile: (options) => saveTextFile(options),
  notify: {
    success: (message, options) => notify.success(message, options),
    error: (message, options) => notify.error(message, options),
    dismiss: (id) => notify.dismiss(id),
  },
  fileImport: {
    prepare: (file, options) => prepareTableFileImport(file, options),
    execute: (options) => executePreparedTableFileImport(options),
    cancel: (jobId) => cancelPreparedTableFileImport(jobId),
  },
  ai: {
    resolveRuntimeModel: (config) => resolveAIConfigRuntimeModel(config),
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
  requestDesignFromRecord: (request) => requestDesignFromRecord(request),
  locale: () => getCurrentLocale(),
}
