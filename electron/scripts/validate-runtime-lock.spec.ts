import { describe, expect, it } from 'vitest'
import { validateRuntimeLockAgainstPackage } from './validate-runtime-lock.mjs'

const validLock = {
  schemaVersion: 1,
  runtimeVersion: '1.2.3',
  protocolVersion: 1,
  releaseTag: 'v1.2.3',
  repository: 'KitionAI/kition-dev',
}

describe('validateRuntimeLockAgainstPackage', () => {
  it('accepts an aligned package and runtime lock', () => {
    expect(validateRuntimeLockAgainstPackage(validLock, { version: '1.2.3' })).toMatchObject(validLock)
  })

  it('rejects version drift', () => {
    expect(() => validateRuntimeLockAgainstPackage(validLock, { version: '1.2.4' }))
      .toThrow('runtime lock version 1.2.3 does not match package version 1.2.4')
  })

  it('rejects a different binary repository', () => {
    expect(() => validateRuntimeLockAgainstPackage({ ...validLock, repository: 'KitionAI/runtime-assets' }, { version: '1.2.3' }))
      .toThrow('runtime repository must be KitionAI/kition-dev')
  })
})
