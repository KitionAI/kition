import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

/**
 * PropertiesDrawer is the right-side editing surface. It mirrors the mockup
 * §drawer chrome (kind pill + title + close button + body) and is fully
 * controlled — the parent owns selectedNodeId / open state. The drawer
 * collapses to zero width when closed so the canvas can reclaim the space.
 *
 * Width is currently fixed at the mockup's 360px; a future resize handle
 * can be added without changing the public surface.
 *
 * Keyboard / focus contract (added 2026-06 for WF-U5):
 *   - Esc pressed while focus is inside the drawer fires onClose. We scope
 *     the handler to the drawer element (not document) so users typing
 *     inside the canvas don't accidentally close the drawer with Esc when
 *     dismissing some other popover.
 *   - On open, the close button receives focus so screen-reader users
 *     land on a meaningful affordance; on close, focus returns to whoever
 *     had it before the drawer opened (typically the NodeCard that was
 *     selected).
 *   - No focus trap — the drawer is inline, not a modal. Users can Tab
 *     out to the canvas or status banner without first hitting Close.
 */
export interface PropertiesDrawerProps {
  open: boolean
  /** Short uppercase kind label rendered as the pill (e.g. "Action"). */
  kind?: 'Trigger' | 'Action' | 'Filter'
  title: string
  onClose: () => void
  children: ReactNode
  /** Optional footer rendered below the body (above the bottom edge of the
   *  drawer). The mockup uses this slot for the SaveBar so it floats with
   *  the editing surface rather than the page chrome. */
  footer?: ReactNode
}

const pillTone: Record<NonNullable<PropertiesDrawerProps['kind']>, string> = {
  Trigger: 'bg-success/10 text-success-foreground',
  Action: 'bg-primary/15 text-primary',
  Filter: 'bg-blue-50 text-blue-700',
}

export function PropertiesDrawer({ open, kind = 'Action', title, onClose, children, footer }: PropertiesDrawerProps) {
  const { t } = useTranslation('workflow')
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const kindLabel = {
    Trigger: t('panels.drawer.kindTrigger'),
    Action: t('panels.drawer.kindAction'),
    Filter: t('panels.drawer.kindFilter'),
  }[kind]

  // Drive focus across the open/close transition. Capture whatever had
  // focus before the drawer opened (typically the NodeCard the user just
  // clicked) so Esc-or-Close restores it; on open, focus the close button
  // so keyboard / screen-reader users land on a known affordance instead
  // of being orphaned at the page root.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Defer to next tick so the close button is mounted before we focus.
      // Without this, the first open after a render with `open=false`
      // (which returns the sr-only stub above) would target a null ref.
      const handle = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
      return () => window.clearTimeout(handle)
    }
    // Closed: restore focus only if the previously-focused element is
    // still mounted. If the user clicked elsewhere mid-edit it would have
    // moved focus naturally and we shouldn't yank it back.
    const prev = previouslyFocused.current
    if (prev && document.body.contains(prev)) {
      prev.focus()
    }
    previouslyFocused.current = null
  }, [open])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      // stopPropagation so a parent listener (e.g. a modal underneath the
      // canvas) doesn't also act on the same Esc — drawer wins.
      event.stopPropagation()
      onClose()
    }
  }

  if (!open) {
    return <div data-testid="workflow-properties-drawer" data-state="closed" className="sr-only" />
  }
  return (
    <aside
      data-testid="workflow-properties-drawer"
      data-state="open"
      onKeyDown={handleKeyDown}
      className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-border bg-card"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${pillTone[kind]}`}>{kindLabel}</span>
        <h2 className="m-0 truncate text-sm font-semibold">{title}</h2>
        <button
          type="button"
          ref={closeButtonRef}
          onClick={onClose}
          className="ml-auto inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          aria-label={t('panels.drawer.closeAria')}
          data-testid="workflow-properties-drawer-close"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">{children}</div>
      {footer ? (
        <div
          className="border-t border-border bg-warning/10 px-4 py-3"
          data-testid="workflow-drawer-savebar"
        >
          {footer}
        </div>
      ) : null}
    </aside>
  )
}

/**
 * DrawerSection / DrawerField are the rest of the drawer's primitives —
 * kept here (rather than as separate files) because they are tightly bound
 * to the drawer's typographic rhythm and have no callers outside it yet.
 */
export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-1 first:mt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="mt-2 grid gap-3">{children}</div>
    </section>
  )
}

export function DrawerField({
  label,
  hint,
  action,
  error,
  children,
}: {
  label: string
  hint?: string
  action?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="flex items-center justify-between gap-2">
        <span>
          {label} {hint ? <span className="font-normal text-muted-foreground/80">{hint}</span> : null}
        </span>
        {action}
      </span>
      {children}
      {error ? (
        <span className="text-[11px] font-normal text-destructive" data-testid="drawer-field-error">
          {error}
        </span>
      ) : null}
    </label>
  )
}
