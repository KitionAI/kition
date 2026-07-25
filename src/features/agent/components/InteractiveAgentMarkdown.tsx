import { useEffect, useRef, type MouseEvent } from 'react'

import {
  markdownToHtml,
  markdownToInteractiveHtml,
} from '@/services/markdownRenderer'
import { hydrateMermaidBlocks } from '@/services/mermaid'

export function InteractiveAgentMarkdown({
  content,
  className,
  onOpenPath,
}: {
  content: string
  className: string
  onOpenPath?: (path: string) => void
}) {
  const ref = useRef<HTMLElement | null>(null)
  const html = onOpenPath
    ? markdownToInteractiveHtml(content)
    : markdownToHtml(content)

  useEffect(() => {
    void hydrateMermaidBlocks(ref.current)
  }, [html])

  function handleClick(event: MouseEvent<HTMLElement>) {
    if (!onOpenPath) {
      return
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-open-path]',
    )
    const path = String(target?.dataset.openPath || '').trim()
    if (!target || !path) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onOpenPath(path)
  }

  return (
    <article
      ref={ref}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  )
}
