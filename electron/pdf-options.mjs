/**
 * Translates the renderer's PDF export request into Electron printToPDF
 * options. Electron 21 and later take a custom pageSize in inches and
 * ignore the legacy marginsType option, so both are mapped here.
 */

const CSS_PIXELS_PER_INCH = 96

/** A named paper size, or the design artboard's size in inches when given in pixels. */
export function resolvePdfPageSize(request) {
  const width = Number(request?.page_width_px)
  const height = Number(request?.page_height_px)
  if (width > 0 && height > 0) {
    return { width: width / CSS_PIXELS_PER_INCH, height: height / CSS_PIXELS_PER_INCH }
  }
  const format = String(request?.page_format || 'a4').toLowerCase()
  return format.charAt(0).toUpperCase() + format.slice(1)
}

/** The legacy 0/1/2 margin codes as Electron's margin types. */
export function pdfMarginType(marginsType) {
  if (marginsType === 1) return 'none'
  if (marginsType === 2) return 'printableArea'
  return 'default'
}

export function buildPrintToPdfOptions(request) {
  const options = {
    pageSize: resolvePdfPageSize(request),
    printBackground: true,
    preferCSSPageSize: false,
    landscape: Boolean(request?.landscape),
    margins: { marginType: pdfMarginType(request?.margins_type) },
  }
  const scalePercent = Number(request?.scale_factor)
  if (Number.isFinite(scalePercent) && scalePercent > 0) {
    options.scale = Math.min(2, Math.max(0.1, scalePercent / 100))
  }
  return options
}
