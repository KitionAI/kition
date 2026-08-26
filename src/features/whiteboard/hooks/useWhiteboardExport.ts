import { useCallback } from 'react'

import {
  isPublicOrExternalFileURL,
  resolveWorkspaceFileURL,
} from '@/services/workspaceFiles'

import { exportBoardSvg } from '../lib/boardExport'
import type { WhiteboardElement } from '../lib/whiteboardTypes'

export function useWhiteboardExport(elements: readonly WhiteboardElement[]) {
  const buildSvg = useCallback(async (
    title: string,
    imageFallback: WhiteboardExportImageFallback = 'portable',
  ) => {
    const imageHrefs = await resolveWhiteboardExportImageHrefs(
      elements,
      globalThis.fetch,
      imageFallback,
    )
    return exportBoardSvg({ elements, imageHrefs, title })
  }, [elements])

  const exportSvg = useCallback(async (title: string) => {
    const svg = await buildSvg(title)
    if (!svg) return false
    downloadWhiteboardSvg(svg, getWhiteboardExportFilename(title))
    return true
  }, [buildSvg])

  const exportPng = useCallback(async (title: string) => {
    const svg = await buildSvg(title, 'resolved')
    if (!svg) return false
    const png = await renderWhiteboardSvgToPng(svg)
    downloadBrowserBlob(png, getWhiteboardExportFilename(title, 'png'))
    return true
  }, [buildSvg])

  return { exportPng, exportSvg }
}

export async function resolveWhiteboardExportImageHrefs(
  elements: readonly WhiteboardElement[],
  fetchImage: typeof fetch = globalThis.fetch,
  fallbackMode: WhiteboardExportImageFallback = 'portable',
) {
  const paths = Array.from(new Set(elements
    .filter((element) => element.kind === 'image')
    .map((element) => element.workspacePath)))
  const entries = await Promise.all(paths.map(async (path) => {
    const source = isPublicOrExternalFileURL(path)
      ? path
      : resolveWorkspaceFileURL(path)
    const fallback: [string, string] = [
      path,
      fallbackMode === 'resolved' ? source || path : path,
    ]
    if (!source || !fetchImage) return fallback
    try {
      const response = await fetchImage(source)
      if (!response.ok) return fallback
      return [path, await readBlobAsDataUrl(await response.blob())] as [string, string]
    } catch {
      return fallback
    }
  }))
  return new Map(entries)
}

type WhiteboardExportImageFallback = 'portable' | 'resolved'

export function getWhiteboardExportFilename(title: string, extension = 'svg') {
  const safeTitle = (title || 'board').replace(/[\\/:*?"<>|]/g, '_').trim() || 'board'
  return `${safeTitle}.${extension}`
}

export function downloadWhiteboardSvg(svg: string, filename: string) {
  downloadBrowserBlob(new Blob([svg], {
    type: 'image/svg+xml;charset=utf-8',
  }), filename)
}

export async function renderWhiteboardSvgToPng(
  svg: string,
  options: { maxDimension?: number; maxPixels?: number } = {},
) {
  const size = getWhiteboardPngRasterSize(svg, options)
  const rasterSvg = replaceWhiteboardSvgDimensions(svg, size)
  const sourceUrl = window.URL.createObjectURL(new Blob([rasterSvg], {
    type: 'image/svg+xml;charset=utf-8',
  }))
  try {
    const source = await loadSvgImage(sourceUrl)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create PNG drawing context')
    context.drawImage(source, 0, 0, size.width, size.height)
    return await canvasToPngBlob(canvas)
  } finally {
    window.URL.revokeObjectURL(sourceUrl)
  }
}

export function getWhiteboardPngRasterSize(
  svg: string,
  options: { maxDimension?: number; maxPixels?: number } = {},
) {
  const dimensions = readWhiteboardSvgDimensions(svg)
  const maxDimension = Math.max(1, options.maxDimension ?? 4096)
  const maxPixels = Math.max(1, options.maxPixels ?? 16_000_000)
  const scale = Math.min(
    1,
    maxDimension / dimensions.width,
    maxDimension / dimensions.height,
    Math.sqrt(maxPixels / (dimensions.width * dimensions.height)),
  )
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  }
}

function downloadBrowserBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

function readWhiteboardSvgDimensions(svg: string) {
  const root = svg.match(/<svg\b[^>]*\bwidth="([^"]+)"[^>]*\bheight="([^"]+)"[^>]*>/i)
  const width = Number(root?.[1])
  const height = Number(root?.[2])
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Could not determine SVG export dimensions')
  }
  return { width, height }
}

function replaceWhiteboardSvgDimensions(
  svg: string,
  size: { width: number; height: number },
) {
  return svg.replace(
    /(<svg\b[^>]*\bwidth=")[^"]+("[^>]*\bheight=")[^"]+("[^>]*>)/i,
    `$1${size.width}$2${size.height}$3`,
  )
}

function loadSvgImage(sourceUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const source = new Image()
    source.decoding = 'async'
    source.onerror = () => reject(new Error('Could not load SVG for PNG export'))
    source.onload = () => resolve(source)
    source.src = sourceUrl
  })
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Could not encode PNG export'))
    }, 'image/png')
  })
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read image data'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsDataURL(blob)
  })
}
