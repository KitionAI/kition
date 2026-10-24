/**
 * Files around documents: opening and importing files, copying images, and saving exports to disk.
 */
import { type SavePdfFileRequest, type WorkspaceFileChooseResponse, type WorkspaceFileImportRequest, getDesktopBridge } from './bridge'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'
import { runtimeFetch } from '../runtimeAuth'

export async function openWorkspaceFile(path: string) {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.OpenWorkspaceFile) {
    const error = await bridge.OpenWorkspaceFile({ path: normalizedPath })
    if (error) throw new Error(error)
    return error
  }
  throw new Error('desktop file opening is unavailable')
}

export async function importWorkspaceFile(request: WorkspaceFileImportRequest) {
  const bridge = getDesktopBridge()
  if (!bridge?.ImportWorkspaceFile) {
    throw new Error('desktop file import is unavailable')
  }
  const payload: WorkspaceFileImportRequest = {
    ...request,
    folder: request.folder ? normalizeWorkspaceDocumentPath(request.folder) : '',
  }
  const response = await bridge.ImportWorkspaceFile(payload)
  if (response?.imported_path) {
    response.imported_path = normalizeWorkspaceDocumentPath(response.imported_path)
  }
  return response
}

export async function chooseFilesToImport(): Promise<WorkspaceFileChooseResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseFilesToImport) {
    return { canceled: true, paths: [] }
  }
  return bridge.ChooseFilesToImport()
}

async function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('failed to read image blob'))
    reader.readAsDataURL(blob)
  })
}

export async function saveBinaryFile(options: { dialogTitle: string; defaultFilename: string; bytes: Uint8Array }) {
  const bridge = getDesktopBridge()
  if (!bridge?.SaveBinaryFile) {
    throw new Error('desktop save is unavailable')
  }

  return bridge.SaveBinaryFile({
    dialog_title: options.dialogTitle,
    default_filename: options.defaultFilename,
    base64_content: uint8ArrayToBase64(options.bytes),
  })
}

export async function savePdfFile(options: {
  dialogTitle: string
  defaultFilename: string
  html: string
  pageFormat?: string
  documentPath?: string
  landscape?: boolean
  marginsType?: 0 | 1 | 2
  scaleFactor?: number
  pageSizePx?: { width: number; height: number }
}) {
  const bridge = getDesktopBridge()
  if (!bridge?.SavePdfFile) {
    throw new Error('desktop PDF export is unavailable')
  }

  const request: SavePdfFileRequest = {
    dialog_title: options.dialogTitle,
    default_filename: options.defaultFilename,
    html: options.html,
    page_format: options.pageFormat,
  }
  if (options.documentPath) {
    request.document_path = options.documentPath
  }
  if (typeof options.landscape === 'boolean') {
    request.landscape = options.landscape
  }
  if (options.marginsType === 0 || options.marginsType === 1 || options.marginsType === 2) {
    request.margins_type = options.marginsType
  }
  if (typeof options.scaleFactor === 'number' && Number.isFinite(options.scaleFactor)) {
    request.scale_factor = options.scaleFactor
  }
  if (options.pageSizePx && options.pageSizePx.width > 0 && options.pageSizePx.height > 0) {
    request.page_width_px = options.pageSizePx.width
    request.page_height_px = options.pageSizePx.height
  }

  return bridge.SavePdfFile(request)
}

async function imageBlobToPng(blob: Blob) {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('image canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('image conversion failed'))
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

export async function copyImageToClipboard(url: string) {
  const source = String(url || '').trim()
  if (!source) throw new Error('image URL is required')

  const bridge = getDesktopBridge()
  if (bridge?.CopyImage) {
    try {
      return await bridge.CopyImage({ url: source })
    } catch {
      const response = await runtimeFetch(source)
      if (!response.ok) throw new Error(`image download failed: ${response.status}`)
      const png = await imageBlobToPng(await response.blob())
      return bridge.CopyImage({ url: await blobToDataURL(png) })
    }
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('image clipboard is unavailable')
  }
  const response = await runtimeFetch(source)
  if (!response.ok) throw new Error(`image download failed: ${response.status}`)
  const png = await imageBlobToPng(await response.blob())
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  return true
}

export function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
