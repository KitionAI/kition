import { describe, expect, it } from 'vitest'

import { resetWindowSessionIdForTests, windowSessionId, windowSessionOrigin } from './windowSession'

describe('windowSessionId', () => {
  it('is stable within a page', () => {
    resetWindowSessionIdForTests()
    const first = windowSessionId()
    const second = windowSessionId()
    expect(first).toBe(second)
  })

  it('changes after a reset, as a new page load would get a new id', () => {
    resetWindowSessionIdForTests()
    const first = windowSessionId()
    resetWindowSessionIdForTests()
    const second = windowSessionId()
    expect(first).not.toBe(second)
  })

  it('reports the origin the runtime records for this window', () => {
    resetWindowSessionIdForTests()
    expect(windowSessionOrigin()).toBe(`person:session:${windowSessionId()}`)
  })
})
