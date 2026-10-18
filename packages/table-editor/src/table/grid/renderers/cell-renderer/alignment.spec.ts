import { describe, expect, it } from 'vitest'

import {
  getAlignedContentStart,
  getAlignedTextX,
  getCenteredBlockTop,
  getTextBlockHeight,
} from './alignment'

describe('cell alignment helpers', () => {
  it('centers text inside the full cell width', () => {
    expect(getAlignedTextX(20, 200, 8, 'center')).toBe(120)
  })

  it('centers inline content inside the padded draw area', () => {
    expect(getAlignedContentStart(28, 184, 64, 'center')).toBe(88)
  })

  it('centers a single text line by its visual font height', () => {
    expect(getCenteredBlockTop(40, getTextBlockHeight(1, 13, 22), 10)).toBe(13.5)
  })

  it('keeps overflowing text at the configured top inset', () => {
    expect(getCenteredBlockTop(32, getTextBlockHeight(3, 13, 22), 10)).toBe(10)
  })
})
