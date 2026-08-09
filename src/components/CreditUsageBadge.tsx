import type { ButtonHTMLAttributes, HTMLAttributes, MouseEvent } from 'react'
import { AlertTriangle, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'

type SharedAttrs = Pick<
  HTMLAttributes<HTMLElement>,
  'id' | 'className' | 'role' | 'title' | 'tabIndex'
> & {
  [dataAttr: `data-${string}`]: string | number | boolean | undefined
  [ariaAttr: `aria-${string}`]: string | number | boolean | undefined
}

type CreditTone = 'ok' | 'warn' | 'danger' | 'neutral'

type CreditUsageBadgeProps = SharedAttrs & {
  creditBalance: number
  creditTotal: number
  /** ISO timestamp for next credit reset. Drives the "Resets in Nd" hint. */
  creditResetAt?: string | null
  /** When provided + tone is critical, an inline "Top up" CTA appears. */
  topupUrl?: string
  /** Outer click target opens billing / profile detail. */
  onViewCredits?: () => void
  /** Override for the inline top-up button. Falls back to opening `topupUrl`. */
  onTopup?: () => void
  variant?: 'default' | 'compact'
}

const WARN_RATIO = 0.3
const DANGER_RATIO = 0.1
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

function normalizeCreditValue(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatCreditValue(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    normalizeCreditValue(value),
  )
}

function classifyTone(balance: number, total: number): CreditTone {
  if (total <= 0) return 'neutral'
  const ratio = balance / total
  if (ratio < DANGER_RATIO) return 'danger'
  if (ratio < WARN_RATIO) return 'warn'
  return 'ok'
}

/**
 * Render a short relative-time hint for when credits reset, suitable as a
 * secondary line under the balance. Suppresses anything more than ~60 days
 * out (too distant to matter) and anything already in the past.
 */
function describeReset(resetAt: string | null | undefined): string | null {
  if (!resetAt) return null
  const ts = Date.parse(resetAt)
  if (!Number.isFinite(ts)) return null
  const diffMs = ts - Date.now()
  if (diffMs <= 0) return null
  if (diffMs > 60 * MS_PER_DAY) return null
  const days = Math.round(diffMs / MS_PER_DAY)
  if (days <= 0) {
    const hours = Math.max(1, Math.round(diffMs / MS_PER_HOUR))
    return hours === 1 ? 'Resets in 1h' : `Resets in ${hours}h`
  }
  if (days === 1) return 'Resets tomorrow'
  return `Resets in ${days}d`
}

export function CreditUsageBadge({
  creditBalance,
  creditTotal,
  creditResetAt,
  topupUrl,
  className,
  onViewCredits,
  onTopup,
  variant = 'default',
  ...props
}: CreditUsageBadgeProps) {
  const balance = normalizeCreditValue(creditBalance)
  const total = normalizeCreditValue(creditTotal)
  const ratio = total > 0 ? Math.min(1, balance / total) : 0
  const percent = Math.round(ratio * 100)
  const tone = classifyTone(balance, total)
  const compact = variant === 'compact'
  const interactive = Boolean(onViewCredits)
  const balanceLabel = formatCreditValue(balance)
  const totalLabel = formatCreditValue(total)
  const amountLabel = `${balanceLabel} / ${totalLabel}`
  const resetLine = describeReset(creditResetAt)
  // Compact mode stays single-row to match the workspace sidebar controls.
  // The full X / Y, percent, and reset hint remain available through title.
  const metaLine = compact ? null : resetLine
  const showTrack = !compact
  const showTopup = tone === 'danger' && Boolean(topupUrl)

  const handleTopup = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (onTopup) {
      onTopup()
      return
    }
    if (topupUrl && typeof window !== 'undefined') {
      window.open(topupUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const detailParts = [
    `${amountLabel} credits`,
    `${percent}% remaining`,
    resetLine,
  ].filter(Boolean) as string[]
  const detailLabel = detailParts.join(' · ')
  const ariaLabel = `Credits ${detailLabel}`
  const Icon = tone === 'danger' ? AlertTriangle : Zap

  const body = (
    <>
      <div className="credit-usage-card__main">
        <Icon className="credit-usage-card__icon" aria-hidden="true" />
        <span className="credit-usage-card__label">Credits</span>
        {compact ? (
          <span className="credit-usage-card__amount">{balanceLabel}</span>
        ) : (
          <>
            <span className="credit-usage-card__amount">{amountLabel}</span>
            <span className="credit-usage-card__percent">{percent}%</span>
          </>
        )}
        <span className="credit-usage-card__spacer" aria-hidden="true" />
        {showTopup ? (
          <button
            type="button"
            className="credit-usage-card__topup"
            onClick={handleTopup}
            data-testid="portal-credit-topup"
          >
            Top up
          </button>
        ) : null}
      </div>
      {showTrack ? (
        <div className="credit-usage-card__track" aria-hidden="true">
          <div className="credit-usage-card__bar" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {metaLine ? (
        <div className="credit-usage-card__meta">{metaLine}</div>
      ) : null}
    </>
  )

  const classes = cn(
    'credit-usage-card',
    `credit-usage-card--${tone}`,
    compact && 'credit-usage-card--compact',
    interactive && 'credit-usage-card--interactive',
    className,
  )

  if (interactive) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onViewCredits}
        aria-label={ariaLabel}
        title={detailLabel}
        data-tone={tone}
        {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {body}
      </button>
    )
  }

  return (
    <div
      className={classes}
      aria-label={ariaLabel}
      title={detailLabel}
      data-tone={tone}
      {...(props as HTMLAttributes<HTMLDivElement>)}
    >
      {body}
    </div>
  )
}
