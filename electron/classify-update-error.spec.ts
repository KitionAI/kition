import { describe, expect, it } from 'vitest'
import { classifyUpdateError } from './classify-update-error.mjs'

describe('classifyUpdateError', () => {
  it('classifies network errors by errno', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).kind).toBe('network')
    expect(classifyUpdateError(new Error('connect ETIMEDOUT 140.82.114.4:443')).kind).toBe('network')
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')).kind).toBe('network')
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_CLOSED')).kind).toBe('network')
    expect(classifyUpdateError(new Error('net::ERR_NETWORK_CHANGED')).kind).toBe('network')
    expect(classifyUpdateError(new Error('getaddrinfo EAI_AGAIN api.github.com')).kind).toBe('network')
  })

  it('classifies signature/checksum failures as verification', () => {
    expect(classifyUpdateError(new Error('sha512 checksum mismatch')).kind).toBe('verification')
    expect(classifyUpdateError(new Error('Code signature at URL ... is not valid')).kind).toBe('verification')
    expect(classifyUpdateError(new Error('blockmap is not valid')).kind).toBe('verification')
  })

  it('classifies disk pressure', () => {
    expect(classifyUpdateError(new Error('ENOSPC: no space left on device')).kind).toBe('disk')
    expect(classifyUpdateError(new Error('Not enough disk space to install')).kind).toBe('disk')
  })

  it('classifies GitHub rate limit', () => {
    expect(classifyUpdateError(new Error('API rate limit exceeded for user 1.2.3.4')).kind).toBe('rate-limit')
    expect(classifyUpdateError(new Error('HttpError: 403 forbidden')).kind).toBe('rate-limit')
  })

  it('falls back to other', () => {
    expect(classifyUpdateError(new Error('something weird happened')).kind).toBe('other')
  })

  it('returns the original message verbatim', () => {
    const original = 'sha512 checksum mismatch for kition.dmg'
    expect(classifyUpdateError(new Error(original)).message).toBe(original)
  })

  it('handles non-Error inputs', () => {
    expect(classifyUpdateError('string error').kind).toBe('other')
    expect(classifyUpdateError(null).kind).toBe('other')
    expect(classifyUpdateError(undefined).kind).toBe('other')
  })
})
