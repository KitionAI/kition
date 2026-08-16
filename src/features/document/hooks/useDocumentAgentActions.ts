import type { EditorView } from '@codemirror/view'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  DocumentAgentAction,
  DocumentAgentActionRequest,
  DocumentAskAgentRequest,
} from '@/features/document/lib/documentAgentActions'

type UseDocumentAgentActionsOptions = {
  documentPath: string
  getView: () => EditorView | null
  onAskAgent?: (request: DocumentAskAgentRequest) => void
}

export function useDocumentAgentActions({
  documentPath,
  getView,
  onAskAgent,
}: UseDocumentAgentActionsOptions) {
  const { t } = useTranslation('document')

  return useCallback((request: DocumentAgentActionRequest) => {
    if (!onAskAgent || !documentPath) return
    let selection = request.selection
    if (!selection) {
      const view = getView()
      const range = view?.state.selection.main
      if (view && range && !range.empty) {
        const text = view.state.doc.sliceString(range.from, range.to).trim()
        if (text) {
          selection = {
            text,
            from: range.from,
            to: range.to,
            line: view.state.doc.lineAt(range.from).number,
          }
        }
      }
    }
    const selectedText = selection?.text.trim().slice(0, 6000) || ''
    onAskAgent({
      documentPath,
      prompt: buildDocumentAgentPrompt(request.action, selectedText, t),
    })
  }, [documentPath, getView, onAskAgent, t])
}

function buildDocumentAgentPrompt(
  action: DocumentAgentAction,
  selectedText: string,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (!selectedText) {
    return t('editor.askAi.prompts.document')
  }
  return t(`editor.askAi.prompts.${action}`, { selection: selectedText })
}
