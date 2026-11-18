import { describe, expect, it } from 'vitest'

import {
  classifyKitionAccountSession,
  isKitionAccountAuthenticated,
  isKitionAccountSessionUsable,
  isKitionAccountUsable,
} from './accountState'

function session(creditBalance?: number, creditTotal?: number) {
  return {
    access_token: 'token',
    token_prefix: 'prefix',
    user_id: 1,
    user_email: 'user@kition.ai',
    expires_at: 1_785_542_400_000,
    credit_balance: creditBalance,
    credit_total: creditTotal,
  }
}

describe('Kition account state', () => {
  it('keeps accounts without a credit summary ready', () => {
    expect(classifyKitionAccountSession(session())).toBe('ready')
  })

  it('distinguishes low and empty credit balances', () => {
    expect(classifyKitionAccountSession(session(29, 100))).toBe('credits_low')
    expect(classifyKitionAccountSession(session(0, 100))).toBe('credits_empty')
    expect(classifyKitionAccountSession(session(30, 100))).toBe('ready')
  })

  it('separates authenticated states from hosted-model usability', () => {
    expect(isKitionAccountAuthenticated('credits_empty')).toBe(true)
    expect(isKitionAccountUsable('credits_empty')).toBe(false)
    expect(isKitionAccountUsable('credits_low')).toBe(true)
    expect(isKitionAccountSessionUsable(session(0, 100))).toBe(false)
    expect(isKitionAccountSessionUsable(session(20, 100))).toBe(true)
  })
})
