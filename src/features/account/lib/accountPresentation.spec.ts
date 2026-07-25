import { describe, expect, it } from 'vitest'

import {
  getAccountCreditLines,
  getAccountPlanName,
  getSubscriptionStatus,
  normalizeAccountActionURL,
} from './accountPresentation'

const baseSession = {
  access_token: 'token',
  token_prefix: 'prefix',
  user_id: 1,
  user_email: 'user@kition.ai',
  expires_at: '2026-08-01T00:00:00Z',
}

describe('account presentation', () => {
  it('uses explicit plan names and readable contract fallbacks', () => {
    expect(getAccountPlanName({ ...baseSession, plan_code: 'basic' })).toBe('Basic')
    expect(getAccountPlanName({ ...baseSession, plan_code: 'creator_plus' })).toBe('Creator Plus')
    expect(getAccountPlanName({ ...baseSession, plan_display_name: 'Founders Plan' })).toBe('Founders Plan')
    expect(getSubscriptionStatus({ ...baseSession, subscription_status: 'past_due' })).toEqual({
      status: 'payment_required',
      fallback: '',
    })
  })

  it('keeps recurring and purchased credits separate', () => {
    expect(getAccountCreditLines({
      ...baseSession,
      period_credit_balance: 60,
      period_credit_total: 100,
      wallet_credit_balance: 27,
      wallet_credit_total: 50,
    })).toEqual([
      { key: 'period', balance: 60, total: 100 },
      { key: 'wallet', balance: 27, total: 50 },
    ])
  })

  it('rejects unsafe account action URLs', () => {
    expect(normalizeAccountActionURL('https://kition.ai/app/billing')).toBe('https://kition.ai/app/billing')
    expect(normalizeAccountActionURL('mailto:support@kition.ai', { allowMailto: true })).toBe('mailto:support@kition.ai')
    expect(normalizeAccountActionURL('javascript:alert(1)')).toBe('')
    expect(normalizeAccountActionURL('file:///tmp/secret')).toBe('')
  })
})
