import { describe, expect, it } from 'vitest'

import {
  getKitionAccountLinks,
  KITION_PRIVACY_URL,
  KITION_SUPPORT_URL,
  KITION_TERMS_URL,
} from './accountLinks'

describe('Kition account links', () => {
  it('uses public fallbacks when the account contract omits actions', () => {
    expect(getKitionAccountLinks()).toMatchObject({
      support: KITION_SUPPORT_URL,
      terms: KITION_TERMS_URL,
      privacy: KITION_PRIVACY_URL,
    })
  })

  it('accepts safe contract actions and rejects unsafe overrides', () => {
    const session = {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 1,
      user_email: 'user@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      billing_url: 'https://billing.kition.ai/manage',
      topup_url: 'javascript:alert(1)',
      support_url: 'mailto:accounts@kition.ai',
    }
    const links = getKitionAccountLinks(session)
    expect(links.billing).toBe('https://billing.kition.ai/manage')
    expect(links.topup).toBe('https://kition.ai/app/billing')
    expect(links.support).toBe('mailto:accounts@kition.ai')
  })
})
