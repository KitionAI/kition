/**
 * Image studio support for designs: the Agent instruction, the artboard's
 * aspect ratio, and how a generated image lands on the artboard as a
 * cover-fit layer with an editable headline on top.
 */
import type { ImagePromptAspectRatio, ImageStudioPlacementOptions, ImageStudioRequest } from '@/features/media-generation/public'
import { createDesignNode, type DesignAsset, type DesignDocument } from './designTypes'

const RATIOS: Array<[ImagePromptAspectRatio, number]> = [
  ['1:1', 1],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
]

/** The studio ratio closest to the artboard, so results fill it with little cropping. */
export function artboardAspectRatio(width: number, height: number): ImagePromptAspectRatio {
  const ratio = width / height
  let best = RATIOS[0]
  for (const candidate of RATIOS) if (Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio)) best = candidate
  return best[0]
}

export function buildDesignImageAgentInstruction(request: ImageStudioRequest) {
  const references = request.sourceImagePaths.map((path, index) => `Reference image ${index + 1}: @{${path}}`)
  return [
    'Complete this Kition Design Image Studio task.',
    `Generate exactly ${request.variants} image ${request.variants === 1 ? 'variant' : 'variants'} using the image_generation tool and save every result as a workspace image artifact.`,
    'Do not call design_propose_patch and do not modify the design. The client will place the saved image artifacts on the artboard after the user reviews them.',
    references.length
      ? 'Use the attached authorized reference image files only for the roles described by the prompt.'
      : 'No reference image is attached.',
    '',
    request.prompt,
    '',
    ...references,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Adds a generated image as a cover-fit layer at the bottom of the stack
 * and, for editable overlay text, a centered headline layer above it.
 * Returns the new document and the ids to select.
 */
export function placeGeneratedImageInDesign(
  source: DesignDocument,
  asset: DesignAsset,
  options: Pick<ImageStudioPlacementOptions, 'exactText' | 'textMode'>,
): { document: DesignDocument; nodeIds: string[] } {
  const doc = structuredClone(source)
  const page = doc.pages[0]
  const scale = Math.max(page.width / asset.width, page.height / asset.height)
  const width = asset.width * scale
  const height = asset.height * scale
  const image = createDesignNode('image', {
    name: asset.path.split('/').pop() || 'Image',
    width,
    height,
    assetId: asset.id,
    transform: [1, 0, 0, 1, (page.width - width) / 2, (page.height - height) / 2],
    crop: { x: 0, y: 0, width: asset.width, height: asset.height },
    constraints: { horizontal: 'scale', vertical: 'scale' },
  })
  doc.assets[asset.id] = asset
  doc.nodes[image.id] = image
  page.children.unshift(image.id)
  const nodeIds = [image.id]
  const text = options.exactText.trim()
  if (options.textMode === 'editable_overlay' && text) {
    const fontSize = Math.round(page.width / 9)
    const textWidth = Math.round(page.width * 0.84)
    const textHeight = Math.round(fontSize * 1.1 * 3)
    const headline = createDesignNode('text', {
      name: text,
      text,
      width: textWidth,
      height: textHeight,
      fontFamily: 'Bricolage Grotesque',
      fontSize,
      fontWeight: 700,
      lineHeight: 1.05,
      textAlign: 'center',
      fill: '#ffffff',
      transform: [1, 0, 0, 1, (page.width - textWidth) / 2, (page.height - textHeight) / 2],
      constraints: { horizontal: 'center', vertical: 'center' },
    })
    doc.nodes[headline.id] = headline
    page.children.push(headline.id)
    nodeIds.push(headline.id)
  }
  return { document: doc, nodeIds }
}
