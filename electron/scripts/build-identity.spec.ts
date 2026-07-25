import { describe, expect, it } from 'vitest'

import {
  classifyReleaseTag,
  portalBaseURLForBuildIdentity,
  resolveBuildIdentity,
} from './build-identity.mjs'

describe('desktop build identity', () => {
  it('derives stable and prerelease identities from immutable release tags', () => {
    expect(classifyReleaseTag('v1.2.3')).toEqual({
      buildIdentity: 'stable',
      prerelease: false,
    })
    expect(classifyReleaseTag('v1.2.4-rc.2')).toEqual({
      buildIdentity: 'rc',
      prerelease: true,
    })
    expect(classifyReleaseTag('v1.0.0-beta.3')).toEqual({
      buildIdentity: 'rc',
      prerelease: true,
    })
  })

  it('keeps local builds in the development identity by default', () => {
    expect(resolveBuildIdentity({})).toBe('dev')
    expect(resolveBuildIdentity({ KITION_BUILD_IDENTITY: 'stable' })).toBe('stable')
    expect(() => resolveBuildIdentity({ KITION_BUILD_IDENTITY: 'prod' })).toThrow(
      'unsupported KITION_BUILD_IDENTITY',
    )
  })

  it('uses the public portal by default for every build identity', () => {
    expect(portalBaseURLForBuildIdentity('dev')).toBe('https://kition.ai')
    expect(portalBaseURLForBuildIdentity('rc')).toBe('https://kition.ai')
    expect(portalBaseURLForBuildIdentity('stable')).toBe('https://kition.ai')
  })
})
