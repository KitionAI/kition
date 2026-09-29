import { renderToStaticMarkup } from 'react-dom/server'
import {
  copyImageToClipboard,
  isDesktopRuntime,
  saveBinaryFile,
  savePdfFile,
} from '@/services/desktop'
import { DesignArtwork } from '../components/DesignArtwork'
import type { DesignDocument } from './designTypes'
import { designFontFaceCSS, loadDesignFonts } from './designFonts'
import {
  blobDataURL,
  decodeDesignImage,
  designAssetDataURL,
} from './designAssets'
export class DesignExportError extends Error {
  constructor(readonly code: 'jpegBackground' | 'exportLimit' | 'pdfDesktopOnly') {
    super(code)
    this.name = 'DesignExportError'
  }
}
export type DesignExportOptions = {
  scale?: number
  /** Overrides the artboard background; 'transparent' or a color. */
  background?: string
}

/** Rejects sizes the rasterizer cannot handle and JPEGs without an opaque background. */
function checkExportLimits(page: DesignDocument['pages'][0], scale: number, format: 'png' | 'jpeg' | 'svg' | 'pdf') {
  const width = Math.round(page.width * scale),
    height = Math.round(page.height * scale)
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32_000_000)
    throw new DesignExportError('exportLimit')
  if (
    format === 'jpeg' &&
    (page.background === 'transparent' ||
      (page.background.length === 9 && page.background.slice(-2).toLowerCase() !== 'ff'))
  )
    throw new DesignExportError('jpegBackground')
  return { width, height }
}

/**
 * The artboard as standalone SVG markup: visible images inlined as data
 * URLs and the used bundled fonts embedded, so the file renders the same
 * outside the app. Exports of every format start here.
 */
export async function buildDesignSVG(
  source: DesignDocument,
  root: string,
  options: DesignExportOptions & { format?: 'png' | 'jpeg' | 'svg' | 'pdf' } = {},
): Promise<{ svg: string; width: number; height: number }> {
  const scale = options.scale ?? 1
  const doc = options.background
    ? { ...source, pages: [{ ...source.pages[0], background: options.background }] as DesignDocument['pages'] }
    : source
  const page = doc.pages[0]
  const { width, height } = checkExportLimits(page, scale, options.format ?? 'png')
  const used = new Set<string>()
  const fonts = new Set<string>()
  const collectVisible = (ids: string[]) => {
    for (const id of ids) {
      const node = doc.nodes[id]
      if (!node?.visible) continue
      if (node.type === 'image' && node.assetId) used.add(node.assetId)
      if (node.type === 'text') fonts.add(node.fontFamily)
      collectVisible(node.children)
    }
  }
  collectVisible(page.children)
  const images: Record<string, string> = {}
  await Promise.all(
    Array.from(used, async (id) => {
      images[id] = await designAssetDataURL(root, doc.assets[id].path)
    }),
  )
  // A standalone SVG cannot reach the app's fonts, so embed the used faces.
  const fontCSS = await designFontFaceCSS(fonts)
  const svg = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${page.width} ${page.height}`}
    >
      {fontCSS ? <style>{fontCSS}</style> : null}
      <DesignArtwork document={doc} images={images} prefix="export" />
    </svg>,
  )
  return { svg, width, height }
}

export async function renderDesignImage(
  doc: DesignDocument,
  root: string,
  format: 'png' | 'jpeg' = 'png',
  scale = 1,
  background?: string,
): Promise<Blob> {
  await loadDesignFonts()
  await document.fonts.ready
  const { svg, width, height } = await buildDesignSVG(doc, root, { scale, background, format })
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = await decodeDesignImage(url),
      canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Image export is unavailable')
    ctx.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Image export failed'))),
        `image/${format}`,
        0.94,
      ),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The artboard as an SVG file. */
export async function renderDesignSVG(doc: DesignDocument, root: string, options: DesignExportOptions = {}): Promise<Blob> {
  const { svg } = await buildDesignSVG(doc, root, { ...options, format: 'svg' })
  return new Blob([svg], { type: 'image/svg+xml' })
}

/** The HTML the desktop prints to a PDF page of exactly the artboard's size. */
export function designPdfHtml(svg: string, width: number, height: number) {
  const data = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:${width}px;height:${height}px}</style></head><body><img src="${data}" alt=""></body></html>`
}

/** Prints the artboard to a PDF through the desktop; browsers cannot. */
export async function exportDesignPDF(
  doc: DesignDocument,
  root: string,
  options: DesignExportOptions & { filename: string; dialogTitle: string },
) {
  if (!isDesktopRuntime()) throw new DesignExportError('pdfDesktopOnly')
  await loadDesignFonts()
  await document.fonts.ready
  const { svg, width, height } = await buildDesignSVG(doc, root, { ...options, format: 'pdf' })
  return savePdfFile({
    dialogTitle: options.dialogTitle,
    defaultFilename: options.filename,
    html: designPdfHtml(svg, width, height),
    pageSizePx: { width, height },
    marginsType: 1,
  })
}
export async function saveDesignImage(
  blob: Blob,
  filename: string,
  dialogTitle: string,
) {
  if (isDesktopRuntime())
    return saveBinaryFile({
      dialogTitle,
      defaultFilename: filename,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    })
  const url = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function copyDesignImage(blob: Blob) {
  if (!(await copyImageToClipboard(await blobDataURL(blob))))
    throw new Error('Image clipboard write failed')
}
