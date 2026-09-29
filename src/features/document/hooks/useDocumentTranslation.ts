import { isolateHistory } from '@codemirror/commands'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip, tooltips } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  MAX_TRANSLATION_CHARACTERS,
  TranslationAccountNotReadyError,
  TranslationModelMissingError,
  type DocumentTranslateText,
  type TranslationLanguage,
} from '@/features/document/lib/documentTranslation'

type DocumentTranslationError = 'model' | 'account' | 'tooLong' | 'failed'

export type DocumentTranslationState =
  | { status: 'closed' }
  | {
    status: 'loading' | 'ready' | 'error'
    source: string
    target: TranslationLanguage
    result: string
    error: DocumentTranslationError | null
    errorMessage: string
    /** The selected text was edited while the card was open; Replace would clobber the edit. */
    stale: boolean
  }

type TooltipRequest = { pos: number; mount: (element: HTMLElement | null) => void } | null

const setTranslationTooltip = StateEffect.define<TooltipRequest>()

/** The tooltip anchor follows document edits; the card is mounted into its DOM by React. */
const translationTooltipField = StateField.define<{ request: TooltipRequest; tooltip: Tooltip | null }>({
  create: () => ({ request: null, tooltip: null }),
  update(value, transaction) {
    let request = value.request
    for (const effect of transaction.effects) {
      if (effect.is(setTranslationTooltip)) request = effect.value
    }
    if (request && transaction.docChanged) {
      request = { ...request, pos: transaction.changes.mapPos(request.pos, 1) }
    }
    if (request === value.request) return value
    if (!request) return { request: null, tooltip: null }
    const current = request
    return {
      request: current,
      tooltip: {
        pos: current.pos,
        above: false,
        strictSide: false,
        arrow: false,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-document-translation-tooltip'
          current.mount(dom)
          return { dom, destroy: () => current.mount(null) }
        },
      },
    }
  },
  provide: (field) => showTooltip.compute([field], (state) => state.field(field).tooltip),
})

const TOOLTIP_EDGE_MARGIN = 16

function tooltipSpaceWithMargin(view: EditorView) {
  const win = view.dom.ownerDocument.defaultView || window
  return {
    top: TOOLTIP_EDGE_MARGIN,
    left: TOOLTIP_EDGE_MARGIN,
    bottom: win.innerHeight - TOOLTIP_EDGE_MARGIN,
    right: win.innerWidth - TOOLTIP_EDGE_MARGIN,
  }
}

/** Paragraph end after `pos`: the last non-blank line of the block that contains it. */
function blockEnd(view: EditorView, pos: number) {
  const doc = view.state.doc
  let line = doc.lineAt(pos)
  while (line.number < doc.lines) {
    const next = doc.line(line.number + 1)
    if (!next.text.trim()) break
    line = next
  }
  return line.to
}

type UseDocumentTranslationOptions = {
  getView: () => EditorView | null
  translateText?: DocumentTranslateText
}

/**
 * One translation card at a time: captures the selection, calls the
 * workspace-supplied translator, tracks the source range through edits, and
 * applies the result. Returns a CodeMirror extension the editor must include.
 */
export function useDocumentTranslation({ getView, translateText }: UseDocumentTranslationOptions) {
  const [state, setState] = useState<DocumentTranslationState>({ status: 'closed' })
  const [cardElement, setCardElement] = useState<HTMLElement | null>(null)
  const rangeRef = useRef<{ from: number; to: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const runRequest = useCallback((source: string, target: TranslationLanguage) => {
    abortRef.current?.abort()
    const base = { source, target, result: '', error: null, errorMessage: '', stale: false } as const
    if (!translateText) return
    if (source.length > MAX_TRANSLATION_CHARACTERS) {
      setState({ status: 'error', ...base, error: 'tooLong' })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setState((current) => ({ status: 'loading', ...base, stale: current.status !== 'closed' && current.stale }))
    translateText(source, target, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.trim()) {
          setState((current) => current.status === 'closed' ? current : { ...current, status: 'error', error: 'failed', errorMessage: 'Empty translation' })
          return
        }
        setState((current) => current.status === 'closed' ? current : { ...current, status: 'ready', result, target })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const kind: DocumentTranslationError = error instanceof TranslationModelMissingError
          ? 'model'
          : error instanceof TranslationAccountNotReadyError ? 'account' : 'failed'
        setState((current) => current.status === 'closed' ? current : {
          ...current,
          status: 'error',
          error: kind,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }, [translateText])

  const close = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    rangeRef.current = null
    setState({ status: 'closed' })
    const view = getView()
    if (view) {
      view.dispatch({ effects: setTranslationTooltip.of(null) })
      view.focus()
    }
  }, [getView])

  /** Opens the card for the current selection and starts translating into `target`. */
  const open = useCallback((target: TranslationLanguage) => {
    const view = getView()
    if (!view || !translateText) return
    const range = view.state.selection.main
    if (range.empty) return
    const source = view.state.sliceDoc(range.from, range.to)
    if (!source.trim()) return
    rangeRef.current = { from: range.from, to: range.to }
    view.dispatch({ effects: setTranslationTooltip.of({ pos: range.to, mount: setCardElement }) })
    runRequest(source, target)
  }, [getView, runRequest, translateText])

  const retry = useCallback(() => {
    const current = stateRef.current
    if (current.status === 'closed') return
    const view = getView()
    const range = rangeRef.current
    // Re-read the source so a retry after an edit translates the new text.
    const source = view && range ? view.state.sliceDoc(range.from, range.to) : current.source
    setState({ ...current, stale: false })
    runRequest(source, current.target)
  }, [getView, runRequest])

  const changeTarget = useCallback((target: TranslationLanguage) => {
    const current = stateRef.current
    if (current.status === 'closed') return
    runRequest(current.source, target)
  }, [runRequest])

  const replace = useCallback(() => {
    const current = stateRef.current
    const view = getView()
    const range = rangeRef.current
    if (current.status !== 'ready' || current.stale || !view || !range) return
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: current.result },
      selection: { anchor: range.from + current.result.length },
      userEvent: 'input.translate',
      // Its own undo step, so typing right after does not merge into it.
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    })
    close()
  }, [close, getView])

  const insertBelow = useCallback(() => {
    const current = stateRef.current
    const view = getView()
    const range = rangeRef.current
    if (current.status !== 'ready' || !view || !range) return
    const at = blockEnd(view, range.to)
    const insert = `\n\n${current.result}`
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      userEvent: 'input.translate',
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    })
    close()
  }, [close, getView])

  const copy = useCallback(async () => {
    const current = stateRef.current
    if (current.status !== 'ready') return false
    await navigator.clipboard.writeText(current.result)
    return true
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const extension = useMemo<Extension>(() => [
    translationTooltipField,
    // Keep tooltips, the card included, a margin away from the window edges.
    tooltips({ tooltipSpace: tooltipSpaceWithMargin }),
    // The card draws its own surface; drop CodeMirror's default tooltip frame.
    EditorView.theme({
      '.cm-tooltip.cm-document-translation-tooltip': {
        border: 'none',
        background: 'transparent',
        zIndex: '40',
      },
    }),
    EditorView.updateListener.of((update) => {
      const range = rangeRef.current
      if (!range || !update.docChanged) return
      const touched = update.changes.touchesRange(range.from, range.to)
      rangeRef.current = {
        from: update.changes.mapPos(range.from, 1),
        to: update.changes.mapPos(range.to, -1),
      }
      if (touched) {
        setState((current) => current.status === 'closed' || current.stale ? current : { ...current, stale: true })
      }
    }),
    Prec.high(keymap.of([{
      key: 'Escape',
      run: () => {
        if (stateRef.current.status === 'closed') return false
        close()
        return true
      },
    }])),
  ], [close])

  return {
    state,
    cardElement,
    extension,
    open,
    close,
    retry,
    changeTarget,
    replace,
    insertBelow,
    copy,
  }
}
