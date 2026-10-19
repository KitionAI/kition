/**
 * What a Markdown editor edits: the text of a document replica, through one `TextBinding` per
 * editor view. Kition's `DocumentSession` is one; `replicaTextSource` makes one on a replica its
 * caller keeps (the Document kit's editor), and `createReplicaTextSource` a standalone one (a
 * replica that is never saved), for previews and tests.
 */
import { isolateHistory } from '@codemirror/commands'
import { Transaction, type Extension } from '@codemirror/state'
import { randomActor, type ObjectId, type Origin, type Replica } from '@kition/kdm'
import { TextBinding } from './codeMirrorBinding'
import { documentHistoryExtension } from './documentHistory'
import { applyTextEdits, diffText, mergeEdits } from './documentMerge'
import { DOCUMENT_BODY } from './documentSchema'
import { analyzeText, createDocumentReplica, documentBody, documentRootId } from './documentText'

export type DocumentTextSource = {
  /** The document text (`\n` line endings, no byte order mark). */
  text(): string
  /** A binding for one editor view; release it when the editor goes away. */
  createBinding(): TextBinding
  releaseBinding(binding: TextBinding): void
  /** The replica's undo and redo for an editor (`documentHistoryExtension`). */
  historyExtension(): Extension
  /** Replaces the text by `next` as the smallest edits, one transaction; answers whether it changed. */
  replaceText(next: string, origin: Origin): boolean
  /** Applies `base → next` three-way onto the text as it is now; answers whether it changed. */
  applyFrom(base: string, next: string, origin: Origin): boolean
  /** A session marks the agent's edit under review in its editors; a standalone source has no reviews. */
  agentReviewExtension?(): Extension
}

const LOCAL_ORIGIN: Origin = { kind: 'person', principal: 'user:local', label: 'typing' }

/** Typing within this delay of the previous keystroke stays in one undo step (as `DocumentSession` groups it). */
const TYPING_GROUP_MS = 500

type TypingKind = 'type' | 'delete'

function typingKind(transaction: Transaction): TypingKind | null {
  const event = transaction.annotation(Transaction.userEvent)
  if (!event) return null
  if (event.startsWith('input.type')) return 'type'
  if (event === 'delete.backward' || event === 'delete.forward' || event === 'delete') return 'delete'
  return null
}

/**
 * Undo groups for typing on `replica`, like CodeMirror's history: a run of keystrokes of one kind
 * undoes as one step. `beforeLocal` sees each editor transaction before it is published; `end`
 * closes the open group (before an undo, a redo, or a whole-text change).
 */
function typingGroups(replica: Replica) {
  let typing: { kind: TypingKind; at: number; timer: ReturnType<typeof setTimeout> } | null = null
  const end = () => {
    const open = typing
    if (!open) return
    typing = null
    clearTimeout(open.timer)
    try {
      replica.endUndoGroup()
    } catch {
      // The replica ended the group already (an undo).
    }
  }
  const beforeLocal = (transaction: Transaction) => {
    const kind = typingKind(transaction)
    const isolated = transaction.annotation(isolateHistory) !== undefined
    const now = Date.now()
    if (typing && (isolated || kind !== typing.kind || now - typing.at > TYPING_GROUP_MS)) end()
    if (!kind || isolated) return
    if (!typing) {
      try {
        replica.beginUndoGroup()
      } catch {
        return
      }
      typing = { kind, at: now, timer: setTimeout(end, TYPING_GROUP_MS) }
      return
    }
    clearTimeout(typing.timer)
    typing.at = now
    typing.timer = setTimeout(end, TYPING_GROUP_MS)
  }
  return { beforeLocal, end }
}

export type ReplicaTextSourceOptions = {
  /** The origin of the editors' edits; a local person typing by default. */
  origin?: Origin
  /** Keystrokes of one kind in a run undo as one step, rather than one step each. */
  groupTyping?: boolean
}

/**
 * A document text source on `replica`, which the caller keeps (saves it, exchanges its changes):
 * editors bound to it edit its text, and its undo and redo are the replica's.
 */
export function replicaTextSource(replica: Replica, rootId: ObjectId = documentRootId(replica), options: ReplicaTextSourceOptions = {}): DocumentTextSource {
  const origin = options.origin ?? LOCAL_ORIGIN
  const groups = options.groupTyping ? typingGroups(replica) : null
  const bindings = new Set<TextBinding>()
  const history = {
    undo: () => {
      groups?.end()
      return replica.undo()
    },
    redo: () => {
      groups?.end()
      return replica.redo()
    },
  }
  const transactEdits = (edits: ReturnType<typeof diffText>, editOrigin: Origin) => {
    groups?.end()
    replica.transact(editOrigin, (tx) => applyTextEdits(tx, rootId, DOCUMENT_BODY, edits))
  }
  return {
    text: () => documentBody(replica, rootId),
    createBinding: () => {
      const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, origin, groups ? { beforeLocal: groups.beforeLocal } : {})
      bindings.add(binding)
      return binding
    },
    releaseBinding: (binding: TextBinding) => {
      if (bindings.delete(binding)) binding.dispose()
    },
    historyExtension: (): Extension => documentHistoryExtension(history),
    replaceText: (next: string, editOrigin: Origin) => {
      const current = documentBody(replica, rootId)
      const target = analyzeText(next).text
      if (current === target) return false
      transactEdits(diffText(current, target), editOrigin)
      return true
    },
    applyFrom: (base: string, next: string, editOrigin: Origin) => {
      const edits = mergeEdits(analyzeText(base).text, analyzeText(next).text, documentBody(replica, rootId))
      if (!edits.length) return false
      transactEdits(edits, editOrigin)
      return true
    },
  }
}

/** A document text source on a new replica of `text` that nothing saves. */
export function createReplicaTextSource(text: string): DocumentTextSource & { replica: Replica; rootId: ObjectId } {
  const { replica, rootId } = createDocumentReplica(text, randomActor())
  return { ...replicaTextSource(replica, rootId), replica, rootId }
}
