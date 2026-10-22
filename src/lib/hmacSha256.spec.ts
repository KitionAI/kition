import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hmacSha256Hex } from './hmacSha256'

describe('hmacSha256Hex', () => {
  it('matches RFC 4231', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })

  it('matches Node for keys and messages of every block boundary', () => {
    for (const keyLength of [0, 1, 63, 64, 65, 200]) {
      for (const messageLength of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
        const key = 'k'.repeat(keyLength)
        const message = `é${'m'.repeat(messageLength)}`
        expect(hmacSha256Hex(key, message), `${keyLength}/${messageLength}`).toBe(createHmac('sha256', key).update(message).digest('hex'))
      }
    }
  })
})
