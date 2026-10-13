import { EditorState, type Extension } from '@codemirror/state'
import { ExternalChange } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef } from 'react'
import type { TextBinding } from '@/features/document/kdm/codeMirrorBinding'
import type { DocumentTextSource } from '@/features/document/kdm/documentTextSource'

/**
 * The binding uses the editor's document as its own: the wrapper's whole-string `value`
 * synchronisation must never replace it (it would publish a stale text as an edit).
 */
const ignoreValueSync = EditorState.transactionFilter.of((transaction) => (
  transaction.annotation(ExternalChange) ? [] : transaction
))

/**
 * Connects one CodeMirror editor to a document replica: answers the text to create the editor
 * with and the extensions that keep it bound (the `TextBinding`, the replica's undo and redo, the
 * marks of an agent's edit under review).
 * The binding is released once the editor is gone; a remount only binds again, so the text and
 * the undo history (both in the replica) are kept.
 */
export function useDocumentBinding(source: DocumentTextSource) {
  const binding = useMemo(() => source.createBinding(), [source])
  // The editor starts from the replica's text when the binding is made.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per binding on purpose.
  const initialText = useMemo(() => source.text(), [binding])
  const releases = useRef(new Map<TextBinding, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const pending = releases.current
    const timer = pending.get(binding)
    if (timer !== undefined) {
      clearTimeout(timer)
      pending.delete(binding)
    }
    return () => {
      // Deferred: StrictMode runs this cleanup and the effect again with the same binding.
      pending.set(binding, setTimeout(() => {
        pending.delete(binding)
        source.releaseBinding(binding)
      }, 0))
    }
  }, [binding, source])

  const extension = useMemo<Extension>(
    () => [binding.extension, source.historyExtension(), source.agentReviewExtension?.() ?? [], ignoreValueSync],
    [binding, source],
  )

  return { initialText, extension }
}
