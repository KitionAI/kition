import type { PortalAccountSession } from '@/api/desktop'

export type AccountCreditLine = {
  key: 'period' | 'wallet'
  balance: number
  total: number | null
}

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  basic: 'Basic',
  pro: 'Pro',
  business: 'Business',
  enterprise: 'Enterprise',
}

export type AccountSubscriptionStatus =
  | 'active'
  | 'trial'
  | 'payment_required'
  | 'canceled'
  | 'inactive'
  | 'unknown'

function titleCase(value: string) {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

export function getAccountPlanName(session: PortalAccountSession) {
  const displayName = String(session.plan_display_name || '').trim()
  if (displayName) return displayName
  const code = String(session.plan_code || '').trim().toLowerCase()
  return PLAN_NAMES[code] || (code ? titleCase(code) : 'Kition Account')
}

export function getSubscriptionStatus(session: PortalAccountSession): {
  status: AccountSubscriptionStatus
  fallback: string
} {
  const status = String(session.subscription_status || '').trim().toLowerCase()
  if (status === 'active') return { status: 'active', fallback: '' }
  if (status === 'trialing') return { status: 'trial', fallback: '' }
  if (status === 'past_due') return { status: 'payment_required', fallback: '' }
  if (status === 'canceled' || status === 'cancelled') return { status: 'canceled', fallback: '' }
  if (status === 'inactive') return { status: 'inactive', fallback: '' }
  return { status: 'unknown', fallback: status ? titleCase(status) : '' }
}

export function getAccountCreditLines(session: PortalAccountSession): AccountCreditLine[] {
  const lines: AccountCreditLine[] = []
  const periodBalance = finite(session.period_credit_balance)
  const periodTotal = finite(session.period_credit_total)
  if (periodBalance !== null || periodTotal !== null) {
    lines.push({
      key: 'period',
      balance: periodBalance ?? 0,
      total: periodTotal,
    })
  }
  const walletBalance = finite(session.wallet_credit_balance)
  const walletTotal = finite(session.wallet_credit_total)
  if (walletBalance !== null || walletTotal !== null) {
    lines.push({
      key: 'wallet',
      balance: walletBalance ?? 0,
      total: walletTotal,
    })
  }
  return lines
}

export function normalizeAccountActionURL(
  value: unknown,
  options: { allowMailto?: boolean } = {},
) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString()
    }
    if (options.allowMailto && parsed.protocol === 'mailto:') {
      return parsed.toString()
    }
  } catch {
    return ''
  }
  return ''
}
