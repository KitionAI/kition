import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWhiteboardObjectId } from './whiteboardElementId'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.useRealTimers()
})

describe('whiteboard object ids', () => {
  it('are UUID v7 and differ even within the same millisecond', () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T12:00:00Z'), toFake: ['Date'] })
    const ids = Array.from({ length: 64 }, () => createWhiteboardObjectId())
    for (const id of ids) expect(id).toMatch(UUID_V7)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
