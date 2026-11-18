import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { npmLicenseOverride, overrideLicenseText } from './npmLicenseOverrides.mjs'

describe('npmLicenseOverride', () => {
  it('supplies the upstream or canonical text for packages that publish none', () => {
    expect(overrideLicenseText(npmLicenseOverride('@radix-ui/number'))).toContain('Copyright (c) 2022 WorkOS')
    expect(overrideLicenseText(npmLicenseOverride('fastdom'))).toContain('Copyright (c) 2016 Wilson Page')
    expect(overrideLicenseText(npmLicenseOverride('react-remove-scroll-bar'))).toContain('Anton Korzunov')
    expect(overrideLicenseText(npmLicenseOverride('dlv'))).toMatch(/^MIT License\n\nCopyright \(c\) Jason Miller\n/)
    expect(overrideLicenseText(npmLicenseOverride('language-subtag-registry'))).toContain('CC0 1.0 Universal')
    expect(npmLicenseOverride('react')).toBeNull()
  })

  it('names khroma MIT and uses DOMPurify under Apache-2.0', () => {
    expect(npmLicenseOverride('khroma')?.license).toBe('MIT')
    expect(npmLicenseOverride('dompurify')).toMatchObject({ usedUnder: 'Apache-2.0', files: ['LICENSE'] })
  })
})

describe('docs/legal/THIRD_PARTY_NOTICES.txt', () => {
  const notices = readFileSync(resolve('docs/legal/THIRD_PARTY_NOTICES.txt'), 'utf8')

  it('carries a licence text for every npm package', () => {
    expect(notices).not.toContain('License text: not present')
    expect(notices).not.toMatch(/^License: Unknown$/m)
    expect(notices).toMatch(/^fastdom 1\.0\.12\nLicense: MIT\nHomepage: .*\nLicense text: \d+\n/m)
    expect(notices).toMatch(/^khroma 2\.1\.0\nLicense: MIT\n/m)
  })

  it('says which licence DOMPurify is used under, and that kit packages carry their own notices', () => {
    expect(notices).toMatch(/^dompurify [\d.]+\nLicense: \(MPL-2\.0 OR Apache-2\.0\)\nUsed under: Apache-2\.0\n/m)
    expect(notices).toContain('Kit packages bundled with the app carry their own LICENSE, NOTICE and\nTHIRD_PARTY_NOTICES.txt')
  })
})
