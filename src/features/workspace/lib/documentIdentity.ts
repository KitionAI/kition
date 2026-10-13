/**
 * Keeps Markdown documents' identities (the replica store's path index under `.kition/docs/`) in step with file
 * operations in the tree. Each call runs after the file operation succeeded and is best effort: a store failure
 * is logged and never fails or undoes the user's operation. A document that loses its entry is imported again
 * (or recognised by its hash) when next opened.
 */
import { loadDocumentStore } from '@/features/document/public'

type DocumentStore = Awaited<ReturnType<typeof loadDocumentStore>>

async function sync(rootPath: string, update: (store: DocumentStore, options: { expectedRoot?: string }) => Promise<void>) {
  try {
    await update(await loadDocumentStore(), rootPath ? { expectedRoot: rootPath } : {})
  } catch (error) {
    console.warn('[workspace] failed to update the document store index', error)
  }
}

/** A file moved or renamed (with its child pages). */
export function syncDocumentFileMoved(rootPath: string, fromPath: string, toPath: string) {
  if (!fromPath || !toPath || fromPath === toPath) return Promise.resolve()
  return sync(rootPath, (store, options) => store.renameDocument(fromPath, toPath, options))
}

/** A folder moved or renamed. */
export function syncDocumentFolderMoved(rootPath: string, fromPath: string, toPath: string) {
  if (!fromPath || !toPath || fromPath === toPath) return Promise.resolve()
  return sync(rootPath, (store, options) => store.renameDocumentFolder(fromPath, toPath, options))
}

/** A file (with its child pages) was deleted. */
export function syncDocumentFileDeleted(rootPath: string, path: string) {
  return sync(rootPath, (store, options) => store.forgetDocument(path, options))
}

/** A folder was deleted. */
export function syncDocumentFolderDeleted(rootPath: string, path: string) {
  return sync(rootPath, (store, options) => store.forgetDocumentFolder(path, options))
}

/** A file was copied: the copy is a new document. */
export function syncDocumentFileDuplicated(rootPath: string, sourcePath: string, copyPath: string) {
  return sync(rootPath, (store, options) => store.duplicateDocumentIdentity(sourcePath, copyPath, options))
}
