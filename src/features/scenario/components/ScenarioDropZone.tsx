import { useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface ScenarioDropZoneProps {
  onFiles: (files: File[]) => void
  children?: ReactNode
  className?: string
}

/**
 * Returns true when the dataTransfer payload contains real files. The
 * `Files` token is the canonical signal browsers attach for file drags
 * (vs `text/plain`, `text/uri-list` etc.).
 */
function payloadHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = dataTransfer.types
  if (!types) return false
  // `types` is a DOMStringList in some browsers, an array in others. Both
  // support `Array.from`.
  return Array.from(types as Iterable<string>).includes('Files')
}

/**
 * Page-level drop zone. Listens to window-level drag events and renders a
 * highlight overlay while a file drag is in progress over the window. On drop
 * it forwards the dropped files to `onFiles`.
 *
 * The classic dragenter/dragleave pair fires on every child element the user
 * crosses, so we track a counter and treat "active" as `count > 0`. This
 * matches the well-known pattern from HTML5 drag-and-drop docs.
 */
export function ScenarioDropZone({
  onFiles,
  children,
  className,
}: ScenarioDropZoneProps) {
  const [active, setActive] = useState(false)
  const counterRef = useRef(0)
  const onFilesRef = useRef(onFiles)

  useEffect(() => {
    onFilesRef.current = onFiles
  }, [onFiles])

  useEffect(() => {
    function handleEnter(event: DragEvent) {
      if (!payloadHasFiles(event.dataTransfer)) return
      event.preventDefault()
      counterRef.current += 1
      setActive(true)
    }
    function handleOver(event: DragEvent) {
      if (!payloadHasFiles(event.dataTransfer)) return
      // We must preventDefault on dragover for the browser to actually fire
      // a drop event on this target.
      event.preventDefault()
    }
    function handleLeave(event: DragEvent) {
      if (!payloadHasFiles(event.dataTransfer)) return
      counterRef.current = Math.max(0, counterRef.current - 1)
      if (counterRef.current === 0) {
        setActive(false)
      }
    }
    function handleDrop(event: DragEvent) {
      if (!payloadHasFiles(event.dataTransfer)) return
      event.preventDefault()
      counterRef.current = 0
      setActive(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) {
        onFilesRef.current(files)
      }
    }

    window.addEventListener('dragenter', handleEnter)
    window.addEventListener('dragover', handleOver)
    window.addEventListener('dragleave', handleLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleEnter)
      window.removeEventListener('dragover', handleOver)
      window.removeEventListener('dragleave', handleLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  return (
    <div
      data-scenario-dropzone=""
      data-active={active ? 'true' : 'false'}
      className={cn('relative h-full w-full', className)}
    >
      {children}
      {active ? (
        <div
          data-testid="scenario-dropzone-overlay"
          data-scenario-dropzone-overlay=""
          className="pointer-events-none fixed inset-2 z-50 rounded-2xl border-2 border-dashed border-foreground/50 bg-muted/60"
          aria-hidden
        />
      ) : null}
    </div>
  )
}
