/**
 * Files around documents: opening and importing files, saving assets and images, clipboard images, and saving exports to disk.
 */
import { type CopyDocumentHtmlRequest, type SavePdfFileRequest, type WorkspaceAsset, type WorkspaceFileChooseResponse, type WorkspaceFileImportRequest, getDesktopBridge } from './bridge'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'

export async function openWorkspaceFile(path: string) {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.OpenWorkspaceFile) {
    return bridge.OpenWorkspaceFile({ path: normalizedPath })
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

function extensionFromMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    default:
      return '.png'
  }
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  return uint8ArrayToBase64(new Uint8Array(buffer))
}

async function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('failed to read image blob'))
    reader.readAsDataURL(blob)
  })
}

export async function saveWorkspaceAssetFromBlobURL(options: {
  documentPath?: string
  blobURL: string
  index?: number
}): Promise<WorkspaceAsset> {
  const response = await fetch(options.blobURL)
  if (!response.ok) {
    throw new Error(`image blob read failed: ${response.status}`)
  }

  const blob = await response.blob()
  const mimeType = blob.type || 'image/png'
  const bridge = getDesktopBridge()

  if (bridge?.SaveWorkspaceAsset) {
    return bridge.SaveWorkspaceAsset({
      document_path: options.documentPath,
      filename: `image-${options.index || 1}${extensionFromMimeType(mimeType)}`,
      mime_type: mimeType,
      base64_content: await blobToBase64(blob),
    })
  }

  const dataURL = await blobToDataURL(blob)
  return {
    path: dataURL,
    url: dataURL,
    mime_type: mimeType,
  }
}

export async function importWorkspaceImageFromBlobURL(options: {
  folder?: string
  blobURL: string
  index?: number
}): Promise<{ importedPath: string; relativePath: string }> {
  const response = await fetch(options.blobURL)
  if (!response.ok) {
    throw new Error(`image blob read failed: ${response.status}`)
  }

  const blob = await response.blob()
  return importWorkspaceImageFromBlob({
    blob,
    folder: options.folder,
    index: options.index,
  })
}

export async function importWorkspaceImageFromFile(options: {
  file: File
  folder?: string
  index?: number
}): Promise<{ importedPath: string; relativePath: string }> {
  return importWorkspaceImageFromBlob({
    blob: options.file,
    folder: options.folder,
    index: options.index,
  })
}

async function importWorkspaceImageFromBlob(options: {
  blob: Blob
  folder?: string
  index?: number
}) {
  const blob = options.blob
  const mimeType = blob.type || 'image/png'
  const base64 = await blobToBase64(blob)
  const stamp = `${Date.now().toString(36)}-${(options.index || 1).toString(36)}`
  const filename = `pasted-${stamp}${extensionFromMimeType(mimeType)}`

  const result = await importWorkspaceFile({
    folder: options.folder || '',
    filename,
    base64_content: base64,
  })
  const importedPath = String(result?.imported_path || '')
  const folder = String(options.folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normalizedImported = importedPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const relativePath = folder && normalizedImported.startsWith(`${folder}/`)
    ? normalizedImported.slice(folder.length + 1)
    : normalizedImported
  return { importedPath: normalizedImported, relativePath }
}

export function canImportWorkspaceImageFromClipboard() {
  return Boolean(getDesktopBridge()?.ReadClipboardImage)
}

export async function importWorkspaceImageFromClipboard(options: {
  folder?: string
  index?: number
}): Promise<{ importedPath: string; relativePath: string } | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.ReadClipboardImage) {
    return null
  }
  const image = await bridge.ReadClipboardImage()
  if (!image?.base64_content) {
    return null
  }

  const folder = String(options.folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const stamp = `${Date.now().toString(36)}-${(options.index || 1).toString(36)}`
  const result = await importWorkspaceFile({
    folder,
    filename: `pasted-${stamp}.png`,
    base64_content: image.base64_content,
  })
  const importedPath = String(result?.imported_path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const relativePath = folder && importedPath.startsWith(`${folder}/`)
    ? importedPath.slice(folder.length + 1)
    : importedPath
  return { importedPath, relativePath }
}

export async function saveTextFile(options: { dialogTitle: string; defaultFilename: string; content: string }) {
  const bridge = getDesktopBridge()
  if (!bridge?.SaveTextFile) {
    throw new Error('desktop save is unavailable')
  }

  return bridge.SaveTextFile(options.dialogTitle, options.defaultFilename, options.content)
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

export async function copyDocumentHtmlToClipboard(options: {
  html: string
  text: string
  documentPath?: string
}) {
  const bridge = getDesktopBridge()
  if (bridge?.CopyDocumentHtml) {
    const request: CopyDocumentHtmlRequest = {
      html: options.html,
      text: options.text,
    }
    if (options.documentPath) {
      request.document_path = options.documentPath
    }
    return bridge.CopyDocumentHtml(request)
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('rich clipboard is unavailable')
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([options.html], { type: 'text/html' }),
      'text/plain': new Blob([options.text], { type: 'text/plain' }),
    }),
  ])
  return true
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
      const response = await fetch(source)
      if (!response.ok) throw new Error(`image download failed: ${response.status}`)
      const png = await imageBlobToPng(await response.blob())
      return bridge.CopyImage({ url: await blobToDataURL(png) })
    }
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('image clipboard is unavailable')
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error(`image download failed: ${response.status}`)
  const png = await imageBlobToPng(await response.blob())
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  return true
}

export async function saveRemoteFile(url: string, defaultFilename: string, dialogTitle: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`download failed: ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  return saveBinaryFile({
    dialogTitle,
    defaultFilename,
    bytes: new Uint8Array(buffer),
  })
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
