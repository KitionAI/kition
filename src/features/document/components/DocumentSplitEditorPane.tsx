import { EditorView } from '@codemirror/view'
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownSourceEditor, type MarkdownCursorSnapshot } from './MarkdownSourceEditor'
import {
  clampSplitEditorRatio,
  readSplitEditorRatio,
  writeSplitEditorRatio,
} from '@/features/workspace/lib/workspacePersistence'
import { hydrateMermaidBlocks } from '@/services/mermaid'

export function DocumentSplitEditorPane({
  value,
  previewHtml,
  readOnly,
  onChange,
  onCursorChange,
}: {
  value: string
  previewHtml: string
  readOnly: boolean
  onChange: (value: string) => void
  onCursorChange?: (snapshot: MarkdownCursorSnapshot) => void
}) {
  const { t } = useTranslation('document')
  const sourceViewRef = useRef<EditorView | null>(null)
  const previewRef = useRef<HTMLElement | null>(null)
  const scrollOwnerRef = useRef<'source' | 'preview' | null>(null)
  const scrollReleaseTimerRef = useRef<number | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const [splitRatio, setSplitRatio] = useState<number>(() => readSplitEditorRatio())
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)

  const releaseScrollLockSoon = useCallback(() => {
    if (scrollReleaseTimerRef.current) {
      window.clearTimeout(scrollReleaseTimerRef.current)
    }
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      scrollOwnerRef.current = null
      scrollReleaseTimerRef.current = null
    }, 80)
  }, [])

  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      sourceViewRef.current = view
      const scrollDom = view.scrollDOM
      const onScroll = () => {
        if (scrollOwnerRef.current === 'preview') return
        const preview = previewRef.current
        if (!preview) return
        const sourceRange = scrollDom.scrollHeight - scrollDom.clientHeight
        const previewRange = preview.scrollHeight - preview.clientHeight
        if (sourceRange <= 0 || previewRange <= 0) return
        scrollOwnerRef.current = 'source'
        preview.scrollTop = (scrollDom.scrollTop / sourceRange) * previewRange
        releaseScrollLockSoon()
      }
      scrollDom.addEventListener('scroll', onScroll, { passive: true })
    },
    [releaseScrollLockSoon],
  )

  const handlePreviewScroll = useCallback<React.UIEventHandler<HTMLElement>>(
    (event) => {
      if (scrollOwnerRef.current === 'source') return
      const view = sourceViewRef.current
      if (!view) return
      const scrollDom = view.scrollDOM
      const preview = event.currentTarget
      const previewRange = preview.scrollHeight - preview.clientHeight
      const sourceRange = scrollDom.scrollHeight - scrollDom.clientHeight
      if (sourceRange <= 0 || previewRange <= 0) return
      scrollOwnerRef.current = 'preview'
      scrollDom.scrollTop = (preview.scrollTop / previewRange) * sourceRange
      releaseScrollLockSoon()
    },
    [releaseScrollLockSoon],
  )

  useEffect(
    () => () => {
      if (scrollReleaseTimerRef.current) {
        window.clearTimeout(scrollReleaseTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    void hydrateMermaidBlocks(previewRef.current)
  }, [previewHtml])

  const handleDividerPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const container = splitContainerRef.current
    if (!container) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setIsDraggingDivider(true)
    let latestRatio = splitRatio

    function handlePointerMove(pointerEvent: PointerEvent) {
      const containerEl = splitContainerRef.current
      if (!containerEl) return
      const rect = containerEl.getBoundingClientRect()
      if (rect.width <= 0) return
      const nextRatio = clampSplitEditorRatio((pointerEvent.clientX - rect.left) / rect.width)
      latestRatio = nextRatio
      setSplitRatio(nextRatio)
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setIsDraggingDivider(false)
      writeSplitEditorRatio(latestRatio)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }, [splitRatio])

  const handleDividerDoubleClick = useCallback(() => {
    const reset = clampSplitEditorRatio(0.5)
    setSplitRatio(reset)
    writeSplitEditorRatio(reset)
  }, [])

  return (
    <div className="document-editor-view is-active">
      <div
        ref={splitContainerRef}
        className="document-markdown-split"
        style={{ ['--split-ratio' as string]: `${splitRatio}` }}
      >
        <div className="document-markdown-pane">
          <MarkdownSourceEditor
            value={value}
            readOnly={readOnly}
            onChange={onChange}
            placeholder={t('splitEditor.sourcePlaceholder')}
            onCreateEditor={handleCreateEditor}
            onCursorChange={onCursorChange}
          />
        </div>
        <button
          type="button"
          className={`document-markdown-split__divider${isDraggingDivider ? ' is-dragging' : ''}`}
          onPointerDown={handleDividerPointerDown}
          onDoubleClick={handleDividerDoubleClick}
          aria-label={t('splitEditor.dividerAriaLabel')}
          aria-orientation="vertical"
          role="separator"
          tabIndex={-1}
        />
        <div className="document-markdown-pane">
          <article
            ref={previewRef}
            className="document-markdown-preview"
            onScroll={handlePreviewScroll}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>
    </div>
  )
}
