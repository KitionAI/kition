import { describe, expect, it } from 'vitest'

import { getGridTheme, lightGridTheme } from '../../configs'
import { getColumnFreezeVisibleHeight } from './layoutRenderer'

describe('getColumnFreezeVisibleHeight', () => {
  it('stops the freeze guide at the end of short table content', () => {
    expect(getColumnFreezeVisibleHeight(1400, 56, 920, 0)).toBe(920)
  })

  it('accounts for vertical scroll and never becomes shorter than the header', () => {
    expect(getColumnFreezeVisibleHeight(700, 56, 920, 300)).toBe(620)
    expect(getColumnFreezeVisibleHeight(700, 56, 280, 400)).toBe(56)
  })

  it('uses a neutral freeze guide instead of the highlighted interaction color', () => {
    const darkTheme = getGridTheme(true)

    expect(lightGridTheme.columnFreezeHandlerBg).not.toBe(lightGridTheme.interactionLineColorHighlight)
    expect(darkTheme.columnFreezeHandlerBg).not.toBe(darkTheme.interactionLineColorHighlight)
  })
})
