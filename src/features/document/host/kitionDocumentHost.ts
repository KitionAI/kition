import { setDocumentHost, type DocumentHost } from '@kition/document-editor'
import { loadVaultMarkdownFiles } from '@/features/document/editor/vault/vault-files'
import { notify } from '@/lib/notify'
import {
  canImportWorkspaceImageFromClipboard,
  copyImageToClipboard,
  importWorkspaceImageFromBlobURL,
  importWorkspaceImageFromClipboard,
  importWorkspaceImageFromFile,
  readWorkspaceDocument,
} from '@/services/desktop'
import { resolveWorkspaceImageURL } from '@/services/workspaceFiles'

/**
 * What the Markdown editor asks of Kition: images from the workspace's files, pasted and dropped
 * images kept as workspace attachments, the workspace's notes for wikilink previews, and toasts.
 */
const kitionDocumentHost: DocumentHost = {
  resolveImageURL: resolveWorkspaceImageURL,
  listMarkdownFiles: async () => (await loadVaultMarkdownFiles()).map((file) => file.path),
  readTextFile: async (path) => (await readWorkspaceDocument(path)).content ?? '',
  images: {
    fromFile: importWorkspaceImageFromFile,
    fromURL: importWorkspaceImageFromBlobURL,
    canReadClipboard: canImportWorkspaceImageFromClipboard,
    fromClipboard: importWorkspaceImageFromClipboard,
  },
  copyImage: copyImageToClipboard,
  notify: (kind, message, options) => {
    if (kind === 'success') notify.success(message, options)
    else notify.error(message, options)
  },
}

/** Makes Kition the host of every document editor in this window (`setDocumentHost`). */
export function installKitionDocumentHost() {
  setDocumentHost(kitionDocumentHost)
}
