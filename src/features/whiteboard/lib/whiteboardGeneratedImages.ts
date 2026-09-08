import type { ImagePromptAspectRatio } from '@/features/media-generation/lib/imagePromptTemplates'

import { createWhiteboardElementId } from './whiteboardElementId'
import type {
  WhiteboardElement,
  WhiteboardImageElement,
  WhiteboardPoint,
  WhiteboardTextElement,
  WhiteboardViewport,
} from './whiteboardTypes'

const ASPECT_VALUES: Record<ImagePromptAspectRatio, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
}

export function getGeneratedImagePlacementSize(aspectRatio: ImagePromptAspectRatio) {
  const ratio = ASPECT_VALUES[aspectRatio]
  if (ratio >= 1) {
    return { width: 560, height: Math.round(560 / ratio) }
  }
  return { width: Math.round(480 * ratio), height: 480 }
}

export function getGeneratedImageCenters(input: {
  canvasSize: WhiteboardPoint
  count: number
  imageSize: { width: number; height: number }
  viewport: WhiteboardViewport
}) {
  const count = Math.max(1, Math.min(4, Math.floor(input.count)))
  const gap = 48
  const totalWidth = input.imageSize.width * count + gap * (count - 1)
  const viewportCenter = {
    x: input.viewport.x + input.canvasSize.x / input.viewport.zoom / 2,
    y: input.viewport.y + input.canvasSize.y / input.viewport.zoom / 2,
  }
  return Array.from({ length: count }, (_, index) => ({
    x: viewportCenter.x - totalWidth / 2 + input.imageSize.width / 2
      + index * (input.imageSize.width + gap),
    y: viewportCenter.y,
  }))
}

export function buildEditableImageTextOverlay(input: {
  elements: readonly WhiteboardElement[]
  image: WhiteboardImageElement
  text: string
}) {
  const existing = getEditableImageTextOverlay(input.elements, input.image.id)
  const text = input.text.trim().slice(0, 2000)
  if (!text) return null
  const fontSize = Math.max(18, Math.min(48, input.image.width / 10))
  const overlay: WhiteboardTextElement = {
    id: existing?.id || createWhiteboardElementId('text'),
    kind: 'text',
    x: input.image.x + Math.max(20, input.image.width * 0.07),
    y: input.image.y + Math.max(42, input.image.height * 0.14),
    text,
    fontSize,
    parentId: input.image.parentId,
    sourceRefIds: [input.image.id],
    locked: false,
    rotation: input.image.rotation,
    style: {
      strokeColor: 'white',
      fillColor: 'white',
      fillStyle: 'none',
      dashStyle: 'solid',
      strokeSize: 'm',
      opacity: 1,
    },
  }
  return { element: overlay, existing: Boolean(existing) }
}

export function getEditableImageTextOverlay(
  elements: readonly WhiteboardElement[],
  imageId: string,
) {
  return elements.find((element): element is WhiteboardTextElement => (
    element.kind === 'text'
      && element.sourceRefIds?.includes(imageId) === true
  ))
}
