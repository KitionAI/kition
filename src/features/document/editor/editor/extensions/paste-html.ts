import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { prepareMarkdownImageImport } from '@/features/document/lib/documentMarkdownImages'
import { notifyImageImportFailure } from '@/features/document/lib/documentImageImportFeedback'
import { resolveDocumentClipboard } from '@/features/document/lib/documentClipboard'
import { prepareDocumentRichPaste } from '@/features/document/lib/documentRichPaste'

type PendingPaste = { from: number; to: number; text: string }

const pendingPastes = ViewPlugin.fromClass(class {
  ranges = new Set<PendingPaste>()
  update(update: ViewUpdate) {
    if (update.transactions.some((transaction) => transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) {
      this.ranges.clear()
      return
    }
    if (!update.docChanged) return
    for (const range of this.ranges) {
      let touched = false
      update.changes.iterChangedRanges((from, to) => {
        if (from < range.to && to > range.from) touched = true
      })
      if (touched) this.ranges.delete(range)
      else {
        const empty = range.from === range.to
        range.from = update.changes.mapPos(range.from, 1)
        range.to = empty ? range.from : update.changes.mapPos(range.to, -1)
      }
    }
  }
  destroy() { this.ranges.clear() }
})

export function pasteHtmlExtension({ sourcePath = '' }: { sourcePath?: string } = {}) {
  let plainTextPaste = false
  return [pendingPastes, EditorView.domEventHandlers({
    keydown(event, view) {
      plainTextPaste = event.shiftKey
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        view.plugin(pendingPastes)?.ranges.clear()
      }
    },
    keyup(event) { plainTextPaste = event.shiftKey },
    blur() { plainTextPaste = false },
    paste(event, view) {
      if (view.state.readOnly || plainTextPaste) return false
      const result = resolveDocumentClipboard(event.clipboardData)
      const finishImport = result.format === 'html' && event.clipboardData
        ? prepareDocumentRichPaste(event.clipboardData, sourcePath)
        : prepareMarkdownImageImport(result.markdown, sourcePath)
      if (!finishImport && result.format !== 'html' && result.format !== 'markdown') return false
      event.preventDefault()
      const tracker = view.plugin(pendingPastes)
      if (finishImport && tracker) {
        const ranges = view.state.selection.ranges.map(({ from, to }) => ({
          from, to, text: view.state.doc.sliceString(from, to),
        }))
        ranges.forEach((range) => tracker.ranges.add(range))
        const complete = (markdown: string) => {
          const changes = ranges.filter((range) => tracker.ranges.has(range)
            && view.state.doc.sliceString(range.from, range.to) === range.text)
            .map((range) => ({ from: range.from, to: range.to, insert: markdown }))
          ranges.forEach((range) => tracker.ranges.delete(range))
          if (changes.length && !view.state.readOnly) {
            view.dispatch({ changes, userEvent: 'input.paste', scrollIntoView: true })
          }
        }
        void finishImport().then(complete, (error: unknown) => {
          const active = ranges.some((range) => tracker.ranges.has(range))
          ranges.forEach((range) => tracker.ranges.delete(range))
          if (active) notifyImageImportFailure(error)
        })
      } else {
        view.dispatch(view.state.replaceSelection(result.markdown), {
          scrollIntoView: true, userEvent: 'input.paste',
        })
      }
      return true
    },
  })]
}
