/**
 * The boards open for editing in this window, by workspace path, for what follows open documents
 * (co-editing). A board is announced once its file is open in the editor, and withdrawn when the
 * editor closes or the file can no longer be edited.
 */
import { createOpenDocumentRegistry } from '@/lib/openDocuments'
import type { Replica } from '@/lib/kdm'

export type OpenBoard = {
  path: string
  /** The board's replica now (the editor replaces it when the file is replaced on disk). */
  replica: () => Replica
  /**
   * Merges changes of another replica of the board, as merges of the file do: the canvas is
   * rebuilt from the replica (after a gesture that is running), the merge is no undo step, and
   * the board's session saves it.
   */
  importChanges: (changes: Uint8Array) => void
  /** Calls `listener` after every change the editor shows (edits, merges, undo). */
  subscribe: (listener: () => void) => () => void
  /** Saves a pending change now. */
  save: () => Promise<void>
}

const boards = createOpenDocumentRegistry<OpenBoard>()

export const registerOpenBoard = boards.register
export const followOpenBoards = boards.follow
export const findOpenBoard = boards.find
