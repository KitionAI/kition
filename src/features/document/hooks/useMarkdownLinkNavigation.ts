import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback } from 'react'

import { findMarkdownHeadingOffset } from '../lib/markdownHeadingNavigation'
import { resolveMarkdownLinkTarget, type MarkdownLinkPathResolver } from '../lib/markdownLinkNavigation'

type Options = {
  documentPath: string
  getView: () => EditorView | null
  resolvePath: MarkdownLinkPathResolver
  onNavigate?: (path: string, opts?: { section?: string }) => void
}

export function useMarkdownLinkNavigation({ documentPath, getView, resolvePath, onNavigate }: Options) {
  return useCallback((href: string) => {
    const target = resolveMarkdownLinkTarget(href, documentPath, resolvePath)
    if (!target) return false
    if (target.path === documentPath && target.section) {
      const view = getView()
      if (!view) return true
      const from = findMarkdownHeadingOffset(view.state.doc.toString(), target.section)
      if (from !== null) {
        view.dispatch({
          selection: EditorSelection.cursor(from),
          effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 16 }),
        })
      }
      return true
    }
    if (!onNavigate) return false
    onNavigate(target.path, target.section ? { section: target.section } : undefined)
    return true
  }, [documentPath, getView, resolvePath, onNavigate])
}
