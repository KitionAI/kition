import { useEffect, useRef, useState } from 'react'

import {
  buildBoardDocument,
  parseBoardDocument,
  serializeBoardDocument,
} from '@/features/whiteboard/lib/boardSerialization'
import type { BoardRecord } from '@/features/whiteboard/lib/boardRecords'
import { DEFAULT_WHITEBOARD_VIEWPORT } from '@/features/whiteboard/lib/whiteboardViewport'
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
} from '@/services/desktop'

export type BoardDocumentStatus = 'loading' | 'ready' | 'saving' | 'error'

export function useBoardDocument(options: {
  path: string
  title: string
  isTransacting?: boolean
  records: readonly BoardRecord[]
  replaceDocument: (input: { records: readonly BoardRecord[] }) => void
}) {
  const [status, setStatus] = useState<BoardDocumentStatus>('loading')
  const [error, setError] = useState('')
  const loadedPathRef = useRef('')
  const skipNextSaveRef = useRef(false)

  useEffect(() => {
    let active = true
    loadedPathRef.current = ''
    setStatus('loading')
    setError('')

    void readWorkspaceDocument(options.path)
      .then((document) => {
        if (!active) return
        const parsed = parseBoardDocument(document.content, options.title)
        skipNextSaveRef.current = true
        options.replaceDocument({ records: parsed.records })
        loadedPathRef.current = options.path
        setStatus('ready')
      })
      .catch((reason) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })

    return () => {
      active = false
    }
  }, [options.path, options.replaceDocument, options.title])

  useEffect(() => {
    if (loadedPathRef.current !== options.path) return
    if (options.isTransacting) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }

    const timer = window.setTimeout(() => {
      const content = serializeBoardDocument(buildBoardDocument({
        title: options.title,
        records: options.records,
        // The viewport is per-person view state, not part of the document.
        viewport: DEFAULT_WHITEBOARD_VIEWPORT,
      }))
      setStatus('saving')
      setError('')
      void writeWorkspaceDocument(options.path, content)
        .then(() => setStatus('ready'))
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : String(reason))
          setStatus('error')
        })
    }, 600)

    return () => window.clearTimeout(timer)
  }, [
    options.isTransacting,
    options.path,
    options.records,
    options.title,
  ])

  return { error, status }
}
