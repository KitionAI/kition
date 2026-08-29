import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

export type ContextActionMenuItem = {
  disabled?: boolean
  icon?: ReactNode
  id: string
  label: string
  onSelect: () => void
  separatorBefore?: boolean
}

export function ContextActionMenu({
  items,
  label,
  onClose,
  position,
  testId,
}: {
  items: readonly ContextActionMenuItem[]
  label: string
  onClose: () => void
  position: { x: number; y: number }
  testId?: string
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const focusable = getFocusableItems(menu)
    focusable[0]?.focus()

    function handlePointerDown(event: PointerEvent) {
      if (!menu.contains(event.target as Node)) onClose()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = getFocusableItems(menu)
      if (buttons.length === 0) return
      event.preventDefault()
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + buttons.length) % buttons.length
            : (current - 1 + buttons.length) % buttons.length
      buttons[next]?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[80] min-w-52 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-floating)]"
      style={{
        left: Math.min(position.x, Math.max(8, window.innerWidth - 224)),
        top: Math.min(position.y, Math.max(8, window.innerHeight - items.length * 34 - 16)),
      }}
      role="menu"
      aria-label={label}
      data-testid={testId}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore ? <div className="-mx-1 my-1 h-px bg-border" /> : null}
          <button
            type="button"
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground outline-none hover:bg-muted focus:bg-muted disabled:text-muted-foreground',
            )}
            disabled={item.disabled}
            role="menuitem"
            onClick={() => {
              item.onSelect()
              onClose()
            }}
            data-testid={`context-action-${item.id}`}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

function getFocusableItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
}
