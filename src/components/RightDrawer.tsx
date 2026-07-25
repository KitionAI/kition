import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface RightDrawerProps {
  /** When false, the drawer is unmounted (children disappear). */
  open: boolean
  /** Called when the user clicks the close button. */
  onClose: () => void
  /** Drawer width in px. Defaults to 380. */
  width?: number
  /**
   * Called while the user drags the resize handle. The new width is already
   * clamped to [MIN_WIDTH, MAX_WIDTH] before this fires.
   */
  onResize?: (width: number) => void
  /** Optional title shown in the drawer header. */
  title?: ReactNode
  children: ReactNode
}

const DEFAULT_WIDTH = 380
const MIN_WIDTH = 280
const MAX_WIDTH = 800

/**
 * A right-edge slide-in drawer with a header (title + close button), a
 * resizable left edge, and a body that contains arbitrary children.
 *
 * Animation: the panel slides in from the right via a CSS transform
 * transition (200ms ease-out). When `open` is false the panel is unmounted
 * — no off-screen tab order, no offscreen scroll snap, no surprise focus
 * traps.
 *
 * Resize: the left edge has a 6px-wide drag handle. Pointer-based dragging
 * updates the width as `innerWidth - clientX`, clamped to [280, 800]. The
 * parent owns the width state via `width` + `onResize` — making it easy to
 * persist across re-renders.
 */
export function RightDrawer({
  open,
  onClose,
  width = DEFAULT_WIDTH,
  onResize,
  title,
  children,
}: RightDrawerProps) {
  const draggingRef = useRef(false)

  // Slide-in animation: start off-screen so the browser paints one frame with
  // translateX(100%), then flip to translateX(0) after a requestAnimationFrame
  // tick so the CSS transition actually plays. `visible` resets to false on
  // every unmount (i.e. every time open flips false→true) because useState
  // initialises fresh for each mount.
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!draggingRef.current || !onResize) return
      const next = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, window.innerWidth - event.clientX),
      )
      onResize(next)
    },
    [onResize],
  )

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [handlePointerMove])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      event.preventDefault()
      draggingRef.current = true
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'
      }
    },
    [handlePointerMove, handlePointerUp, onResize],
  )

  // Cleanup any listener if the drawer unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  if (!open) return null

  const clampedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))

  return (
    <aside
      data-testid="right-drawer"
      className="fixed right-0 top-0 z-40 flex h-full flex-col border-l border-border bg-card shadow-floating"
      style={{
        width: `${clampedWidth}px`,
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 200ms ease-out',
      }}
      role="complementary"
      aria-label={typeof title === 'string' ? title : 'Right drawer'}
    >
      {/* Resize handle (left edge) */}
      <div
        data-testid="right-drawer-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize drawer"
        onPointerDown={handlePointerDown}
        className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-muted"
        style={{ touchAction: 'none' }}
      />

      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div
          data-testid="right-drawer-title"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {title ?? null}
        </div>
        <button
          type="button"
          data-testid="right-drawer-close"
          onClick={onClose}
          aria-label="Close drawer"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </aside>
  )
}
