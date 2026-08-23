import { useEffect, useRef, useState } from 'react'

import {
  buildBoardDocument,
  parseBoardDocument,
  serializeBoardDocument,
} from '@/features/whiteboard/lib/boardSerialization'
import type { BoardRecord } from '@/features/whiteboard/lib/boardRecords'
import type { WhiteboardViewport } from '@/features/whiteboard/lib/whiteboardTypes'
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
  viewport: WhiteboardViewport
  replaceDocument: (input: {
    records: readonly BoardRecord[]
    viewport: WhiteboardViewport
  }) => void
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
        options.replaceDocument({
          records: parsed.records,
          viewport: parsed.viewport,
        })
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
        viewport: options.viewport,
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
    options.viewport,
  ])

  return { error, status }
}
