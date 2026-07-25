import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Mail, MoreHorizontal, Plus, Power, Sparkles, Trash2, TriangleAlert, Zap } from 'lucide-react'

export type NodeStatus = 'green' | 'red' | 'amber' | 'muted'

/**
 * NodeCard is the visual primitive used on the workflow canvas. It is
 * deliberately presentation-only: parents pass status and selection, the
 * card handles the rest (icon, badge, hover ai pill, error slot,
 * per-node menu).
 *
 * The layout matches workflow-improvements-mockup.html §node — left icon
 * square, body with badge + title + desc, top-right status dot, inline
 * error inside the body, hover Ask-AI pill at bottom right.
 */
export interface NodeCardProps {
  kind: 'trigger' | 'action' | 'filter'
  /** Short uppercase label rendered next to the badge (e.g. "Step 1 · Email"). */
  rowLabel: string
  title: string
  description: string
  status: NodeStatus
  selected?: boolean
  /** When true, render the card greyed out (disabled by user). The card is
   *  still clickable so the user can re-enable it from the drawer. */
  disabled?: boolean
  onSelect?: () => void
  onAskAI?: () => void
  /** Optional inline error: rendered as a banner inside the card body,
   *  with a Fix button on the right when onFix is provided. Severity
   *  drives the color: `error` (default) uses destructive red, `warning`
   *  uses amber — pick warning for draft-state validation issues that
   *  the user can't actually break anything with yet. */
  inlineError?: { message: string; fixLabel?: string; onFix?: () => void; severity?: 'error' | 'warning' } | null
  /** Slot for extra meta (e.g. relative-time, recipient chip) rendered
   *  right below the description. */
  extra?: ReactNode
  /** Test hook so e2e specs can target individual nodes by role. */
  dataRole?: string
  /** Node-level actions menu — when omitted, the ⋯ button is hidden. */
  onDuplicate?: () => void
  onDelete?: () => void
  onToggleDisabled?: (next: boolean) => void
}

const statusColors: Record<NodeStatus, { dot: string; ring: string; halo: string }> = {
  green: { dot: 'bg-success', ring: 'ring-success/30', halo: 'shadow-[0_0_0_3px_hsl(var(--success)/0.18)]' },
  red: { dot: 'bg-destructive', ring: 'ring-destructive/30', halo: 'shadow-[0_0_0_3px_hsl(var(--destructive)/0.18)]' },
  amber: { dot: 'bg-warning', ring: 'ring-warning/30', halo: 'shadow-[0_0_0_3px_hsl(var(--warning)/0.18)]' },
  muted: { dot: 'bg-muted-foreground/40', ring: 'ring-muted', halo: 'shadow-[0_0_0_3px_hsl(var(--muted)/0.6)]' },
}

const kindIcon = {
  trigger: <Zap className="size-4" />,
  action: <Mail className="size-4" />,
  filter: <Plus className="size-4" />,
}

const kindBadge: Record<NodeCardProps['kind'], string> = {
  trigger: 'bg-success/10 text-success-foreground',
  action: 'bg-primary/15 text-primary',
  filter: 'bg-warning/10 text-warning-foreground',
}

const kindIconWrap: Record<NodeCardProps['kind'], string> = {
  trigger: 'bg-success/10 text-success-foreground',
  action: 'bg-primary/15 text-primary',
  filter: 'bg-warning/10 text-warning-foreground',
}

export function NodeCard({
  kind,
  rowLabel,
  title,
  description,
  status,
  selected,
  disabled,
  onSelect,
  onAskAI,
  inlineError,
  extra,
  dataRole,
  onDuplicate,
  onDelete,
  onToggleDisabled,
}: NodeCardProps) {
  const { t } = useTranslation('workflow')
  const palette = statusColors[status]
  const hasError = status === 'red' || Boolean(inlineError)
  const hasMenu = Boolean(onDuplicate || onDelete || onToggleDisabled)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current) return
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
  return (
    <div
      data-testid="workflow-canvas-node"
      data-node-role={dataRole || kind}
      data-status={status}
      data-selected={selected ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      // aria-pressed mirrors the visual selected state so screen readers
      // can tell whether the drawer is bound to this card. Without it, all
      // the cards announce as identical "button" with no way for assistive
      // tech to distinguish the focused one from the active one.
      aria-pressed={selected ? 'true' : 'false'}
      // Disabled here doesn't mean "non-interactive" (the card is still
      // clickable so the user can re-enable from the drawer) — it means
      // "this step is paused". aria-disabled is the right hook for that
      // semantics; using `disabled` would have removed the card from the
      // tab order entirely.
      aria-disabled={disabled ? 'true' : undefined}
      aria-label={`${kind}: ${title}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.()
        }
      }}
      className={[
        // The Trigger + Action cards live side-by-side in the canvas; their
        // selected state used to differ subtly enough that the eye couldn't
        // tell which one the drawer was bound to. Pin the transitions to the
        // properties we actually animate (border, shadow, background) so the
        // halo grows/shrinks in lockstep on both cards without `transition-all`
        // accidentally easing opacity/transform under hover and friends.
        'group relative flex w-[360px] cursor-pointer gap-3 rounded-xl border bg-card p-3.5 text-left shadow-sm',
        'transition-[border-color,box-shadow,background-color] duration-150 ease-out',
        hasError ? 'border-destructive/30' : 'border-border',
        // Selected state combines three signals so the bound-to-drawer card is
        // unmistakable at a glance — even at 50% zoom or with an adjacent
        // red error card competing for attention:
        //   1) a 3px main-color border (was already here)
        //   2) a stronger drop-shadow (`0_10px_28px`, ~0.20 alpha) so the
        //      card visibly *floats* above the dotted canvas — the previous
        //      `0_6px_18px / 0.12` halo read as a tint, not as elevation
        //   3) a 3px left accent bar via ::before; it survives heavy zoom-out
        //      where the border alone becomes a thin colored line
        selected
          ? hasError
            ? 'border-destructive bg-destructive/10 shadow-[0_0_0_3px_rgba(220,38,38,0.28),0_10px_28px_rgba(220,38,38,0.18)] before:absolute before:left-0 before:inset-y-3 before:w-[3px] before:rounded-r-full before:bg-destructive/100 before:content-[""]'
            : 'border-primary bg-primary/10 shadow-[0_0_0_3px_rgba(86,69,212,0.32),0_10px_28px_rgba(86,69,212,0.20)] before:absolute before:left-0 before:inset-y-3 before:w-[3px] before:rounded-r-full before:bg-primary before:content-[""]'
          : 'hover:border-hairline-strong hover:shadow-[0_2px_6px_rgba(15,15,15,0.06)]',
        disabled ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${kindIconWrap[kind]}`}>
        {kindIcon[kind]}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${kindBadge[kind]}`}>{kind}</span>
          <span className="truncate">{rowLabel}</span>
        </div>
        <p className="m-0 truncate text-sm font-semibold text-foreground">{title}</p>
        <p className="m-0 mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
        {extra ? <div className="mt-1">{extra}</div> : null}
        {inlineError ? (
          <div
            className={
              inlineError.severity === 'warning'
                ? 'mt-2.5 flex items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground'
                : 'mt-2.5 flex items-center gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive'
            }
            data-testid="workflow-node-error"
            data-severity={inlineError.severity || 'error'}
          >
            <TriangleAlert className={inlineError.severity === 'warning' ? 'size-3.5 shrink-0 text-warning' : 'size-3.5 shrink-0'} />
            <span className="min-w-0 truncate">{inlineError.message}</span>
            {inlineError.onFix ? (
              <button
                type="button"
                className={
                  inlineError.severity === 'warning'
                    ? 'ml-auto rounded border border-warning/30 bg-card px-2 py-0.5 text-[11px] font-semibold text-warning-foreground hover:bg-warning/15'
                    : 'ml-auto rounded border border-destructive/30 bg-card px-2 py-0.5 text-[11px] font-semibold text-destructive hover:bg-destructive/15'
                }
                data-testid="workflow-node-fix"
                onClick={(event) => {
                  event.stopPropagation()
                  inlineError.onFix?.()
                }}
              >
                {inlineError.fixLabel || t('canvas.nodeCard.fix')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <span
        aria-label={t('canvas.nodeCard.statusAria', { status })}
        className={`absolute right-3 top-3 size-2.5 rounded-full ${palette.dot} ${palette.halo}`}
      />

      {hasMenu && selected ? (
        <div ref={menuRef} className="absolute right-2 top-2.5 z-20">
          <button
            type="button"
            aria-label={t('canvas.nodeCard.moreActions')}
            data-testid="workflow-node-menu-button"
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen((current) => !current)
            }}
            className="inline-grid size-6 place-items-center rounded-md bg-card/90 text-muted-foreground hover:bg-muted"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              data-testid="workflow-node-menu"
              className="absolute right-0 mt-1 w-44 rounded-lg border border-border bg-card p-1 text-sm shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
            >
              {onDuplicate ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="workflow-node-menu-duplicate"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-muted"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    onDuplicate()
                  }}
                >
                  <Copy className="size-3.5" />
                  <span className="flex-1">{t('canvas.nodeCard.duplicate')}</span>
                </button>
              ) : null}
              {onToggleDisabled ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="workflow-node-menu-disable"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-muted"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    onToggleDisabled(!disabled)
                  }}
                >
                  <Power className="size-3.5" />
                  <span className="flex-1">{disabled ? t('canvas.nodeCard.enableStep') : t('canvas.nodeCard.disableStep')}</span>
                </button>
              ) : null}
              {onDelete ? (
                <>
                  <hr className="my-1 border-border" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="workflow-node-menu-delete"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenuOpen(false)
                      onDelete()
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="flex-1">{t('canvas.nodeCard.delete')}</span>
                    <span className="text-[10px] tracking-wider text-destructive/80">⌫</span>
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {onAskAI ? (
        <button
          type="button"
          data-testid="workflow-node-ask-ai"
          onClick={(event) => {
            event.stopPropagation()
            onAskAI()
          }}
          className="pointer-events-auto absolute bottom-2.5 right-3 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          <Sparkles className="size-3" />
          {t('canvas.nodeCard.askAi')}
        </button>
      ) : null}
    </div>
  )
}
