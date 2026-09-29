import { describe, expect, it } from 'vitest'
import { buildPrintToPdfOptions, pdfMarginType, resolvePdfPageSize } from './pdf-options.mjs'

describe('PDF print options', () => {
  it('uses the artboard size in inches when pixels are given', () => {
    expect(resolvePdfPageSize({ page_width_px: 1080, page_height_px: 1440, page_format: 'a4' })).toEqual({
      width: 11.25,
      height: 15,
    })
  })

  it('maps document page formats to the names Electron accepts', () => {
    expect(resolvePdfPageSize({ page_format: 'a4' })).toBe('A4')
    expect(resolvePdfPageSize({ page_format: 'letter' })).toBe('Letter')
    expect(resolvePdfPageSize({ page_format: 'tabloid' })).toBe('Tabloid')
    expect(resolvePdfPageSize({})).toBe('A4')
  })

  it('maps legacy margin codes to margin types', () => {
    expect([0, 1, 2, undefined].map(pdfMarginType)).toEqual(['default', 'none', 'printableArea', 'default'])
  })

  it('builds printToPDF options with clamped scale', () => {
    expect(buildPrintToPdfOptions({ page_format: 'letter', landscape: true, margins_type: 1, scale_factor: 500 })).toEqual({
      pageSize: 'Letter',
      printBackground: true,
      preferCSSPageSize: false,
      landscape: true,
      margins: { marginType: 'none' },
      scale: 2,
    })
    expect(buildPrintToPdfOptions({}).scale).toBeUndefined()
  })
})
