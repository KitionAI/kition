import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@kition/app-ui/utils'

export type WorkspaceTabContextMenuItem = {
  key: string
  label: string
  shortcut?: string
  disabled?: boolean
  separator?: boolean
  danger?: boolean
  onSelect?: () => void
}

export function WorkspaceTabContextMenu({
  position,
  items,
  onClose,
}: {
  position: { x: number; y: number }
  items: WorkspaceTabContextMenuItem[]
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose()
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    // The page scrolling moves the tab away from the menu; the tab list itself scrolls as a tab is pressed (the
    // right-click that opens the menu), which must not close it.
    function handleScroll(event: Event) {
      if (event.target instanceof Element && event.target.closest('.document-tab-list')) return
      onClose()
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [onClose])

  if (typeof document === 'undefined') {
    return null
  }

  const menuWidth = 240
  const estimatedHeight = items.length * 30 + 16
  const left = Math.min(position.x, Math.max(12, window.innerWidth - menuWidth - 12))
  const top = Math.min(position.y, Math.max(12, window.innerHeight - estimatedHeight - 12))

  return createPortal(
    <div
      ref={rootRef}
      className="app-menu workspace-tab-context-menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.key} className="app-menu-separator" role="separator" />
        }
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={cn(
              'app-menu-item workspace-tab-context-menu-item',
              item.danger && 'is-danger',
            )}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) {
                return
              }
              item.onSelect?.()
              onClose()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
