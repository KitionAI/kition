import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Menu, type MenuEntry, type MenuPosition } from './Menu'

export interface MenuRendererProps {
  menu: Menu
  position: MenuPosition
  onClose: () => void
  parentRect?: DOMRect
  isSubmenu?: boolean
}

export function MenuRenderer({ menu, position, onClose, parentRect, isSubmenu }: MenuRendererProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<{ menu: Menu; rect: DOMRect } | null>(null)
  const [adjusted, setAdjusted] = useState<MenuPosition>(position)

  // Submenu hover open/close is wired in Task 5.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    const margin = 8
    const width = node.offsetWidth
    const height = node.offsetHeight
    let x = position.x
    let y = position.y

    if (isSubmenu && parentRect) {
      if (parentRect.right + width + margin > window.innerWidth) {
        x = parentRect.left - width
      } else {
        x = parentRect.right
      }
      y = parentRect.top
    }

    if (x + width + margin > window.innerWidth) x = window.innerWidth - width - margin
    if (y + height + margin > window.innerHeight) y = window.innerHeight - height - margin
    if (x < margin) x = margin
    if (y < margin) y = margin
    setAdjusted({ x, y })
  }, [position, isSubmenu, parentRect])

  const submenuPosition = useMemo(
    () =>
      openSubmenu
        ? { x: openSubmenu.rect.right, y: openSubmenu.rect.top }
        : null,
    [openSubmenu],
  )

  useEffect(() => {
    if (isSubmenu) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      const insideAnyMenu =
        target instanceof Element
          ? target.closest('.document-menu-portal, .document-menu')
          : null
      if (!insideAnyMenu) onCloseRef.current()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current()
    }
    function onResize() {
      onCloseRef.current()
    }
    function onScroll() {
      onCloseRef.current()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [isSubmenu])

  return (
    <>
      <div
        ref={rootRef}
        className="document-menu"
        style={{ left: adjusted.x, top: adjusted.y }}
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        {menu.items.map((entry, idx) => {
          if (entry.kind === 'separator') {
            return <div key={`sep-${idx}`} className="document-menu-separator" role="separator" />
          }
          return (
            <ItemRow
              key={`it-${idx}`}
              entry={entry}
              onClose={onClose}
              onOpenSubmenu={setOpenSubmenu}
            />
          )
        })}
      </div>
      {openSubmenu && submenuPosition ? (
        <MenuRenderer
          menu={openSubmenu.menu}
          position={submenuPosition}
          onClose={onClose}
          parentRect={openSubmenu.rect}
          isSubmenu
        />
      ) : null}
    </>
  )
}

function ItemRow({
  entry,
  onClose,
  onOpenSubmenu,
}: {
  entry: Extract<MenuEntry, { kind: 'item' }>
  onClose: () => void
  onOpenSubmenu: (next: { menu: Menu; rect: DOMRect } | null) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  return (
    <div
      ref={ref}
      role="menuitem"
      aria-disabled={entry.disabled || undefined}
      className={cn(
        'document-menu-item',
        entry.disabled && 'is-disabled',
        entry.warning && 'is-warning',
      )}
      onMouseEnter={() => {
        if (entry.submenu && ref.current) {
          onOpenSubmenu({ menu: entry.submenu, rect: ref.current.getBoundingClientRect() })
        } else {
          onOpenSubmenu(null)
        }
      }}
      onClick={() => {
        if (entry.disabled || entry.submenu) return
        void entry.onSelect?.()
        onClose()
      }}
    >
      <span className="document-menu-item-icon" data-icon={entry.icon} />
      <span className="document-menu-item-title">{entry.title}</span>
      {entry.submenu ? (
        <ChevronRight className="document-menu-submenu-arrow" size={14} />
      ) : entry.shortcut ? (
        <kbd className="document-menu-shortcut">{entry.shortcut}</kbd>
      ) : null}
    </div>
  )
}
