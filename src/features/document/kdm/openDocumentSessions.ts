/**
 * The Markdown documents open for editing in this window, by workspace path, for what follows open
 * documents (co-editing). A session announces its document once its replica is open, again under
 * a new path after a rename, and withdraws it when it is disposed.
 */
import { createOpenDocumentRegistry } from '@/lib/openDocuments'
import type { Replica } from '@/lib/kdm'

export type OpenMarkdownDocument = {
  path: string
  replica: () => Replica
  /**
   * Imports changes of another replica of the document: the editors show them as they show merged
   * file changes (never through their own undo history), and the session saves them to the file.
   */
  importChanges: (changes: Uint8Array) => void
  /** Calls `listener` after every change of the text (edits, merges, undo). */
  subscribe: (listener: () => void) => () => void
  /** Saves a pending change now. */
  save: () => Promise<void>
  /** The document's id in the replica store (its version history's), once open. */
  storeId: () => string | null
  /** Restores `text` (the document as it was at a checkpoint) as one undo step; answers whether it changed. */
  restoreText: (text: string, label?: string) => boolean
}

const documents = createOpenDocumentRegistry<OpenMarkdownDocument>()

export const registerOpenMarkdownDocument = documents.register
export const followOpenMarkdownDocuments = documents.follow
export const findOpenMarkdownDocument = documents.find
