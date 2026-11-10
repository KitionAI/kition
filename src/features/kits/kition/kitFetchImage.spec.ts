import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchKitImage = vi.hoisted(() => vi.fn())
vi.mock('@/api/kits', () => ({ fetchKitImage }))

import { fetchImageErrorReason } from '../host/protocol'
import { kitionFetchImage } from './kitFetchImage'

afterEach(() => fetchKitImage.mockReset())

describe('kitionFetchImage', () => {
  it('answers the picture the runtime downloaded', async () => {
    const bytes = new Uint8Array([0xff, 0xd8]).buffer
    fetchKitImage.mockResolvedValueOnce({ bytes, mime: 'image/jpeg' })
    await expect(kitionFetchImage({ url: 'https://shimo.example/a.jpg' })).resolves.toEqual({ bytes, mime: 'image/jpeg' })
    expect(fetchKitImage).toHaveBeenCalledWith('https://shimo.example/a.jpg')
  })

  it("passes the runtime's refusal on with its reason, and any other failure as io-error", async () => {
    const refused = (reason: string) => Object.assign(new Error(`refused ${reason}`), { response: { status: 403, data: { code: 40320, message: 'refused', data: { reason } } } })
    for (const reason of ['not-allowed', 'unsupported', 'quota', 'io-error']) {
      fetchKitImage.mockRejectedValueOnce(refused(reason))
      expect(fetchImageErrorReason(await kitionFetchImage({ url: 'https://a.example/b.png' }).catch((error: unknown) => error))).toBe(reason)
    }
    fetchKitImage.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(fetchImageErrorReason(await kitionFetchImage({ url: 'https://a.example/b.png' }).catch((error: unknown) => error))).toBe('io-error')
    fetchKitImage.mockRejectedValueOnce(refused('something-else'))
    expect(fetchImageErrorReason(await kitionFetchImage({ url: 'https://a.example/b.png' }).catch((error: unknown) => error))).toBe('io-error')
  })
})
