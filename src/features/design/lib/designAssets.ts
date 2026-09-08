import { openDB } from 'idb'
import {
  importWorkspaceFile,
  isDesktopRuntime,
  listWorkspaceDocuments,
} from '@/services/desktop'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import {
  createDesignNode,
  designId,
  type DesignAsset,
  type DesignDocument,
} from './designTypes'
import { isPortableDesignPath } from './designSerialization'
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const assetDB = () =>
  openDB('kition-design-assets', 1, {
    upgrade(db) {
      db.createObjectStore('images')
    },
  })
export function blobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
export async function decodeDesignImage(
  url: string,
): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  if (
    !image.naturalWidth ||
    image.naturalWidth > 16384 ||
    image.naturalHeight > 16384 ||
    image.naturalWidth * image.naturalHeight > 64_000_000
  )
    throw new Error('Image dimensions exceed the supported limit')
  return image
}
async function metadata(blob: Blob) {
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      blob.type,
    ) ||
    blob.size > MAX_IMAGE_BYTES
  )
    throw new Error('Use a PNG, JPEG, WebP, or GIF image under 32 MB')
  const url = URL.createObjectURL(blob)
  try {
    const image = await decodeDesignImage(url)
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}
export async function loadDesignAssetBlob(
  root: string,
  path: string,
): Promise<Blob> {
  if (!isPortableDesignPath(path)) throw new Error('Invalid image path')
  if (window.kitionDesktop?.ReadWorkspaceImage) {
    const result = await window.kitionDesktop.ReadWorkspaceImage({
      path,
      expected_root: root,
    })
    return new Blob(
      [
        Uint8Array.from(atob(result.base64_content), (char) =>
          char.charCodeAt(0),
        ),
      ],
      { type: result.mime_type },
    )
  }
  if (!isDesktopRuntime()) {
    const db = await assetDB()
    try {
      const blob = (await db.get('images', `${root}:${path}`)) as
        | Blob
        | undefined
      if (blob) return blob
    } finally {
      db.close()
    }
  }
  if ((await listWorkspaceDocuments()).root_path !== root)
    throw new Error('Workspace changed')
  const response = await fetch(resolveWorkspaceFileURL(path))
  if (!response.ok) throw new Error('Image is unavailable')
  const blob = await response.blob()
  await metadata(blob)
  return blob
}
export async function importDesignImage(
  root: string,
  blob: Blob,
): Promise<DesignAsset> {
  const size = await metadata(blob),
    dataURL = await blobDataURL(blob)
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
    ),
  )
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.slice(6)
  let path = `Attachments/Design/${hash}.${extension}`
  if (isDesktopRuntime()) {
    const imported = await importWorkspaceFile({
      expected_root: root,
      folder: 'Attachments/Design',
      filename: `${hash}.${extension}`,
      base64_content: dataURL.split(',')[1],
    })
    path = imported.imported_path
  } else {
    const db = await assetDB()
    try {
      await db.put('images', blob, `${root}:${path}`)
    } finally {
      db.close()
    }
  }
  return { id: designId(), path, mimeType: blob.type, ...size }
}
export async function existingDesignImage(
  root: string,
  path: string,
): Promise<DesignAsset> {
  const blob = await loadDesignAssetBlob(root, path)
  return {
    id: designId(),
    path,
    mimeType: blob.type,
    ...(await metadata(blob)),
  }
}
export function insertDesignImage(
  source: DesignDocument,
  asset: DesignAsset,
  fullSize = false,
) {
  const doc = structuredClone(source),
    page = doc.pages[0]
  if (fullSize) {
    page.width = asset.width
    page.height = asset.height
  }
  const scale = Math.min(
    page.width / asset.width,
    page.height / asset.height,
    fullSize ? 1 : 0.9,
  )
  const width = asset.width * scale,
    height = asset.height * scale
  const node = createDesignNode('image', {
    name: asset.path.split('/').pop() || 'Image',
    width,
    height,
    assetId: asset.id,
    transform: [
      1,
      0,
      0,
      1,
      (page.width - width) / 2,
      (page.height - height) / 2,
    ],
    crop: { x: 0, y: 0, width: asset.width, height: asset.height },
  })
  doc.assets[asset.id] = asset
  doc.nodes[node.id] = node
  page.children.push(node.id)
  return { document: doc, nodeId: node.id }
}

/** Freeze animated inputs and normalize orientation once for both preview and export. */
export async function designAssetDataURL(root: string, path: string) {
  const blob = await loadDesignAssetBlob(root, path)
  const bitmap = await createImageBitmap(blob)
  try {
    if (
      bitmap.width > 16384 ||
      bitmap.height > 16384 ||
      bitmap.width * bitmap.height > 64_000_000
    )
      throw new Error('Image dimensions exceed the supported limit')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image decoding is unavailable')
    context.drawImage(bitmap, 0, 0)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}
