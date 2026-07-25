import { useEffect, useMemo, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

const FORMULA_FUNCTIONS = ['if', 'concat', 'upper', 'lower', 'len']
const FORMULA_LITERALS = ['true', 'false', 'null']

export function FormulaEditor({
  value,
  onChange,
  placeholder,
  fieldNames,
  readOnly,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  fieldNames: string[]
  readOnly?: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const fieldNamesRef = useRef(fieldNames)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    fieldNamesRef.current = fieldNames
  }, [fieldNames])

  const initialDoc = useMemo(() => value ?? '', [])

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          placeholderExtension(placeholder || '{Quantity} * {Unit price}'),
          autocompletion({
            override: [createFormulaCompletions(() => fieldNamesRef.current)],
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap]),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.readOnly.of(Boolean(readOnly)),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
            '.cm-content': { padding: '8px', minHeight: '64px' },
            '.cm-focused': { outline: 'none' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [initialDoc, placeholder, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== (value ?? '')) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value ?? '' },
      })
    }
  }, [value])

  return <div ref={hostRef} className="data-inline-formula-editor" />
}

function createFormulaCompletions(getFieldNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const beforeCursor = context.state.doc.sliceString(0, context.pos)
    const lastBrace = beforeCursor.lastIndexOf('{')
    const lastClose = beforeCursor.lastIndexOf('}')
    if (lastBrace > lastClose) {
      const from = lastBrace + 1
      return {
        from,
        options: getFieldNames().map((name) => ({
          label: name,
          type: 'variable',
          apply: `${name}}`,
        })),
        validFor: /^[\p{L}\p{N}_]*$/u,
      }
    }
    const word = context.matchBefore(/[a-zA-Z_]\w*/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null
    return {
      from: word.from,
      options: [
        ...FORMULA_FUNCTIONS.map((name) => ({
          label: name,
          type: 'function',
          apply: `${name}()`,
        })),
        ...FORMULA_LITERALS.map((name) => ({ label: name, type: 'keyword' })),
      ],
    }
  }
}
