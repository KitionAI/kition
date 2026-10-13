import { EditorState, type Extension } from '@codemirror/state'
import { ExternalChange } from '@uiw/react-codemirror'
import { useLayoutEffect, useMemo, useState } from 'react'
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
 *
 * A binding follows the replica from the moment it is made, so it is made in an effect, never
 * during render: a render React discards or repeats (StrictMode, an interrupted transition) would
 * leave a binding nobody releases. It is released when the editor goes away or binds to another
 * source; a remount only binds again, so the text and the undo history (both in the replica) are
 * kept. Until the effect has run (before the first paint) the extensions hold no binding; the
 * binding catches the editor up with the replica when it attaches.
 */
export function useDocumentBinding(source: DocumentTextSource) {
  const [bound, setBound] = useState<{ source: DocumentTextSource; binding: TextBinding } | null>(null)

  useLayoutEffect(() => {
    const binding = source.createBinding()
    setBound({ source, binding })
    return () => {
      source.releaseBinding(binding)
      setBound((current) => (current?.binding === binding ? null : current))
    }
  }, [source])

  // The editor starts from the replica's text as it is when the source is first rendered.
  const initialText = useMemo(() => source.text(), [source])
  const binding = bound?.source === source ? bound.binding : null

  const extension = useMemo<Extension>(
    () => [...(binding ? [binding.extension] : []), source.historyExtension(), source.agentReviewExtension?.() ?? [], ignoreValueSync],
    [binding, source],
  )

  return { initialText, extension }
}
