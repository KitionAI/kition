/**
 * What a Markdown editor edits: the text of a document replica, through one `TextBinding` per
 * editor view. A `DocumentSession` is one; `createReplicaTextSource` makes a standalone one (a
 * replica that is never saved), for previews and tests.
 */
import type { Extension } from '@codemirror/state'
import { randomActor, type ObjectId, type Origin, type Replica } from '@kition/kdm'
import { TextBinding } from './codeMirrorBinding'
import { documentHistoryExtension } from './documentHistory'
import { applyTextEdits, diffText, mergeEdits } from './documentMerge'
import { DOCUMENT_BODY } from './documentSchema'
import { analyzeText, createDocumentReplica, documentBody } from './documentText'

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

/** A document text source on a new replica of `text` that nothing saves. */
export function createReplicaTextSource(text: string): DocumentTextSource & { replica: Replica; rootId: ObjectId } {
  const { replica, rootId } = createDocumentReplica(text, randomActor())
  const bindings = new Set<TextBinding>()
  const history = {
    undo: () => replica.undo(),
    redo: () => replica.redo(),
  }
  return {
    replica,
    rootId,
    text: () => documentBody(replica, rootId),
    createBinding: () => {
      const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, LOCAL_ORIGIN)
      bindings.add(binding)
      return binding
    },
    releaseBinding: (binding: TextBinding) => {
      if (bindings.delete(binding)) binding.dispose()
    },
    historyExtension: (): Extension => documentHistoryExtension(history),
    replaceText: (next: string, origin: Origin) => {
      const current = documentBody(replica, rootId)
      const target = analyzeText(next).text
      if (current === target) return false
      const edits = diffText(current, target)
      replica.transact(origin, (tx) => applyTextEdits(tx, rootId, DOCUMENT_BODY, edits))
      return true
    },
    applyFrom: (base: string, next: string, origin: Origin) => {
      const edits = mergeEdits(analyzeText(base).text, analyzeText(next).text, documentBody(replica, rootId))
      if (!edits.length) return false
      replica.transact(origin, (tx) => applyTextEdits(tx, rootId, DOCUMENT_BODY, edits))
      return true
    },
  }
}
