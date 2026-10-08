import { describe, expect, it, vi } from 'vitest'
import { readRemoteImagePayload } from './remote-image.mjs'

describe('remote clipboard image download', () => {
  it('accepts real image bytes from signed downloads served as generic binary', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const fetchImage = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    const source = 'https://example.com/image.png?accessToken=fictional-token&g=sample'
    const result = await readRemoteImagePayload(source, fetchImage)
    expect(result.mime_type).toBe('image/png')
    expect(fetchImage.mock.calls[0][0]).toBe(source)
    await expect(readRemoteImagePayload(source, async () => new Response('not an image', { headers: { 'content-type': 'application/octet-stream' } })))
      .rejects.toThrow('not an image')
  })
  it('downloads bytes without sending referrers or ambient credentials', async () => {
    const fetchImage = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    await expect(readRemoteImagePayload('https://example.com/image.png', fetchImage))
      .resolves.toEqual({ mime_type: 'image/png', base64_content: 'AQID' })
    expect(fetchImage).toHaveBeenCalledWith('https://example.com/image.png', expect.objectContaining({
      referrerPolicy: 'no-referrer', credentials: 'omit', signal: expect.any(AbortSignal),
    }))
  })

  it.each(['file:///tmp/photo.png', 'ftp://example.com/photo.png', 'https://user:secret@example.com/photo.png'])(
    'rejects unsupported source %s before fetching', async (source) => {
      const fetchImage = vi.fn()
      await expect(readRemoteImagePayload(source, fetchImage)).rejects.toThrow('HTTP(S)')
      expect(fetchImage).not.toHaveBeenCalled()
    },
  )

  it('rejects login pages and failed requests instead of storing them as images', async () => {
    await expect(readRemoteImagePayload('https://example.com/image', async () => new Response('<h1>Login</h1>', { headers: { 'content-type': 'text/html' } })))
      .rejects.toThrow('not an image')
    await expect(readRemoteImagePayload('https://example.com/image', async () => new Response('', { status: 403 })))
      .rejects.toThrow('403')
  })

  it('enforces the declared and streamed byte limits', async () => {
    await expect(readRemoteImagePayload('https://example.com/image', async () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': String(51 * 1024 * 1024) } })))
      .rejects.toThrow('50 MB')
    await expect(readRemoteImagePayload('https://example.com/image', async () => new Response(new Uint8Array(51 * 1024 * 1024), { headers: { 'content-type': 'image/png' } })))
      .rejects.toThrow('50 MB')
  })
})
