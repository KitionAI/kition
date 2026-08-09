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

  it('uses the primary color for the freeze handle while keeping the guide neutral', () => {
    const darkTheme = getGridTheme(true)

    expect(lightGridTheme.columnFreezeHandlerBg).toBe(lightGridTheme.cellLineColorActived)
    expect(darkTheme.columnFreezeHandlerBg).toBe(darkTheme.cellLineColorActived)
    expect(lightGridTheme.interactionLineColorCommon).not.toBe(lightGridTheme.columnFreezeHandlerBg)
    expect(darkTheme.interactionLineColorCommon).not.toBe(darkTheme.columnFreezeHandlerBg)
  })

  it('uses the primary color for checked table controls in both themes', () => {
    const darkTheme = getGridTheme(true)

    expect(lightGridTheme.iconBgSelected).toBe(lightGridTheme.cellLineColorActived)
    expect(darkTheme.iconBgSelected).toBe(darkTheme.cellLineColorActived)
    expect(darkTheme.iconBgSelected).not.toBe(darkTheme.cellTextColor)
  })
})
