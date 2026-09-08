import { renderToStaticMarkup } from 'react-dom/server'
import {
  copyImageToClipboard,
  isDesktopRuntime,
  saveBinaryFile,
} from '@/services/desktop'
import { DesignArtwork } from '../components/DesignArtwork'
import type { DesignDocument } from './designTypes'
import {
  blobDataURL,
  decodeDesignImage,
  designAssetDataURL,
} from './designAssets'
export class DesignExportError extends Error {
  constructor(readonly code: 'jpegBackground' | 'exportLimit') {
    super(code)
    this.name = 'DesignExportError'
  }
}
export async function renderDesignImage(
  doc: DesignDocument,
  root: string,
  format: 'png' | 'jpeg' = 'png',
  scale = 1,
): Promise<Blob> {
  const page = doc.pages[0],
    width = Math.round(page.width * scale),
    height = Math.round(page.height * scale)
  if (
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    width * height > 32_000_000
  )
    throw new DesignExportError('exportLimit')
  if (
    format === 'jpeg' &&
    (page.background === 'transparent' ||
      (page.background.length === 9 &&
        page.background.slice(-2).toLowerCase() !== 'ff'))
  )
    throw new DesignExportError('jpegBackground')
  await document.fonts.ready
  const used = new Set<string>()
  const collectVisibleImages = (ids: string[]) => {
    for (const id of ids) {
      const node = doc.nodes[id]
      if (!node.visible) continue
      if (node.type === 'image') used.add(node.assetId!)
      collectVisibleImages(node.children)
    }
  }
  collectVisibleImages(page.children)
  const images: Record<string, string> = {}
  await Promise.all(
    Array.from(used, async (id) => {
      images[id] = await designAssetDataURL(root, doc.assets[id].path)
    }),
  )
  const svg = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${page.width} ${page.height}`}
    >
      <DesignArtwork document={doc} images={images} prefix="export" />
    </svg>,
  )
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
        (blob) =>
          blob ? resolve(blob) : reject(new Error('Image export failed')),
        `image/${format}`,
        0.94,
      ),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
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
