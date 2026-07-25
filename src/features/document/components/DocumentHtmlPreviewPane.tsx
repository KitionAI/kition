import { memo, useState } from 'react'
import { cn } from '@/lib/utils'

type DocumentHtmlPreviewPaneProps = {
  html: string
  title?: string
}

export const DocumentHtmlPreviewPane = memo(function DocumentHtmlPreviewPane({
  html,
  title,
}: DocumentHtmlPreviewPaneProps) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  return (
    <div className="document-editor-view is-active">
      <div className="document-html-preview">
        <div className="document-html-preview__toolbar">
          <button
            type="button"
            className={cn(
              'document-html-preview__tab',
              mode === 'preview' && 'is-active',
            )}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            className={cn(
              'document-html-preview__tab',
              mode === 'source' && 'is-active',
            )}
            onClick={() => setMode('source')}
          >
            Source
          </button>
        </div>
        {mode === 'preview' ? (
          <iframe
            className="document-html-preview__frame"
            title={title || 'HTML preview'}
            sandbox="allow-scripts allow-popups"
            srcDoc={html}
          />
        ) : (
          <pre className="document-html-preview__source">{html}</pre>
        )}
      </div>
    </div>
  )
})
