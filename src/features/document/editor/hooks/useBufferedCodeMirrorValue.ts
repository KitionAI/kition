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
  const pendingControlledEchoesRef = useRef(new Set<string>())

  useEffect(() => {
    if (value === editorValueRef.current) {
      pendingControlledEchoesRef.current.clear()
      return
    }

    if (composingRef.current) {
      return
    }

    if (pendingControlledEchoesRef.current.delete(value)) return

    pendingControlledEchoesRef.current.clear()
    editorValueRef.current = value
    setEditorValue(value)
  }, [value])

  const handleEditorChange = useCallback((nextValue: string) => {
    editorValueRef.current = nextValue
    pendingControlledEchoesRef.current.add(nextValue)
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
