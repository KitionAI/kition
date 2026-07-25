import { describe, expect, it } from 'vitest'

import {
  emailProviderCatalog,
  getEmailProvider,
  resolveEmailProviderId,
} from './emailProviderCatalog'

describe('emailProviderCatalog', () => {
  it('provides secure defaults for common personal email services', () => {
    expect(getEmailProvider('gmail').imap).toEqual({ host: 'imap.gmail.com', port: 993, tlsMode: 'tls' })
    expect(getEmailProvider('163').smtp).toEqual({ host: 'smtp.163.com', port: 465, tlsMode: 'tls' })
    expect(getEmailProvider('outlook').smtp).toEqual({ host: 'smtp.office365.com', port: 587, tlsMode: 'starttls' })
    expect(emailProviderCatalog.length).toBeGreaterThanOrEqual(12)
  })

  it('resolves saved connections back to their provider', () => {
    expect(resolveEmailProviderId('imap', 'imap.gmail.com')).toBe('gmail')
    expect(resolveEmailProviderId('smtp', 'smtp.qq.com', 'person@foxmail.com')).toBe('foxmail')
    expect(resolveEmailProviderId('imap', 'mail.example.com')).toBe('custom')
  })
})
