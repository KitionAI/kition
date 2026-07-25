import type { PortalAccountSession } from '@/api/desktop'

export type KitionAccountStatus =
  | 'loading'
  | 'signed_out'
  | 'connecting'
  | 'ready'
  | 'expired'
  | 'credits_low'
  | 'credits_empty'
  | 'temporary_error'

const LOW_CREDIT_RATIO = 0.3

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function classifyKitionAccountSession(
  session: PortalAccountSession,
): Extract<KitionAccountStatus, 'ready' | 'credits_low' | 'credits_empty'> {
  const balance = finiteNumber(session.credit_balance)
  const total = finiteNumber(session.credit_total)
  if (balance === null || total === null || total <= 0) {
    return 'ready'
  }
  if (balance <= 0) {
    return 'credits_empty'
  }
  return balance / total < LOW_CREDIT_RATIO ? 'credits_low' : 'ready'
}

export function isKitionAccountAuthenticated(status: KitionAccountStatus) {
  return status === 'ready' || status === 'credits_low' || status === 'credits_empty'
}

export function isKitionAccountUsable(status: KitionAccountStatus) {
  return status === 'ready' || status === 'credits_low'
}

export function isKitionAccountSessionUsable(session: PortalAccountSession | null) {
  return Boolean(session && classifyKitionAccountSession(session) !== 'credits_empty')
}
