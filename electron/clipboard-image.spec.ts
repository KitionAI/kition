import { describe, expect, it, vi } from 'vitest'

import { readClipboardImagePayload } from './clipboard-image.mjs'

describe('desktop clipboard image', () => {
  it('returns null when the native clipboard has no image', () => {
    expect(readClipboardImagePayload({
      readImage: () => ({
        isEmpty: () => true,
        toPNG: vi.fn(),
      }),
    })).toBeNull()
  })

  it('normalizes a native clipboard image to PNG for the renderer bridge', () => {
    expect(readClipboardImagePayload({
      readImage: () => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from([1, 2, 3]),
      }),
    })).toEqual({
      mime_type: 'image/png',
      base64_content: 'AQID',
    })
  })
})
