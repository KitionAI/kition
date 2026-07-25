import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface RightSheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** When true, close paths route through onRequestClose first. */
  dirty?: boolean
  /** Called instead of onClose when dirty === true. */
  onRequestClose?: () => void
}

const SHEET_WIDTH = 400

export function RightSheet({
  open,
  onClose,
  title,
  children,
  footer,
  dirty = false,
  onRequestClose,
}: RightSheetProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  function attemptClose() {
    if (dirty && onRequestClose) {
      onRequestClose()
      return
    }
    onClose()
  }

  useEffect(() => {
    if (!open) return
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') attemptClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // attemptClose closes over `dirty` / `onRequestClose` / `onClose`; we want the
    // latest values on every keystroke, so re-bind on each render of an open sheet.
  })

  if (!open) return null

  return (
    <>
      <div
        data-testid="right-sheet-backdrop"
        onClick={attemptClose}
        className="fixed inset-0 z-30 bg-black/30 transition-opacity duration-150"
        style={{ opacity: visible ? 1 : 0 }}
        aria-hidden="true"
      />
      <aside
        data-testid="right-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Right sheet'}
        className="fixed right-0 top-0 z-40 flex h-full flex-col border-l border-border bg-card text-foreground shadow-floating"
        style={{
          width: `${SHEET_WIDTH}px`,
          transform: visible ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 200ms ease-out',
        }}
      >
        <header
          data-testid="right-sheet-header"
          className="flex items-center justify-between border-b border-border px-4 py-3"
        >
          <div className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {title}
          </div>
          <button
            type="button"
            data-testid="right-sheet-close"
            onClick={attemptClose}
            aria-label="Close"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">{children}</div>
        {footer ? (
          <div
            data-testid="right-sheet-footer"
            className="flex shrink-0 justify-end gap-2 border-t border-border bg-card p-4"
          >
            {footer}
          </div>
        ) : null}
      </aside>
    </>
  )
}
