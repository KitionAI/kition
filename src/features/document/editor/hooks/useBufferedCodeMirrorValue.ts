import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type BufferedCodeMirrorValueOptions = {
  value: string
  onChange: (value: string) => void
}

export function useBufferedCodeMirrorValue({ value, onChange }: BufferedCodeMirrorValueOptions) {
  const [editorValue, setEditorValue] = useState(value)
  const editorValueRef = useRef(value)
  const composingRef = useRef(false)
  const awaitingControlledEchoRef = useRef(false)

  useEffect(() => {
    if (value === editorValueRef.current) {
      awaitingControlledEchoRef.current = false
      return
    }

    if (composingRef.current || awaitingControlledEchoRef.current) {
      return
    }

    editorValueRef.current = value
    setEditorValue(value)
  }, [value])

  const handleEditorChange = useCallback((nextValue: string) => {
    editorValueRef.current = nextValue
    awaitingControlledEchoRef.current = true
    setEditorValue(nextValue)
    onChange(nextValue)
  }, [onChange])

  const compositionExtension = useMemo(
    () => EditorView.domEventHandlers({
      compositionstart: () => {
        composingRef.current = true
        return false
      },
      compositionend: () => {
        composingRef.current = false
        return false
      },
    }),
    [],
  )

  return {
    compositionExtension,
    editorValue,
    handleEditorChange,
  }
}
