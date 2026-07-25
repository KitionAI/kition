import { describe, expect, it } from 'vitest'

import { parseConsoleCreditsExhausted } from './consoleCredits'

describe('parseConsoleCreditsExhausted', () => {
  it('keeps safe billing destinations', () => {
    expect(parseConsoleCreditsExhausted({
      code: 'credits_exhausted',
      message: 'No credits',
      topup_url: 'https://kition.ai/app/billing',
    })).toMatchObject({
      message: 'No credits',
      topupUrl: 'https://kition.ai/app/billing',
    })
  })

  it('drops unsafe or malformed billing destinations', () => {
    expect(parseConsoleCreditsExhausted({
      code: 'credits_exhausted',
      topup_url: 'javascript:alert(1)',
    })?.topupUrl).toBe('')
    expect(parseConsoleCreditsExhausted({
      code: 'credits_exhausted',
      topup_url: 'not a url',
    })?.topupUrl).toBe('')
  })
})
