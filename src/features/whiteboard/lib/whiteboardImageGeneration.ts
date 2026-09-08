import type {
  ImagePromptAspectRatio,
  ImagePromptTemplateId,
  ImagePromptTextMode,
} from '@/features/media-generation/lib/imagePromptTemplates'

export type WhiteboardImageGenerationRequest = {
  aspectRatio: ImagePromptAspectRatio
  boardPath: string
  exactText?: string
  prompt: string
  quality: 'low' | 'medium' | 'high'
  replaceElementId?: string
  requestId: string
  resolution: '1K' | '2K' | '4K'
  sourceImagePaths: string[]
  templateId: ImagePromptTemplateId
  textMode: ImagePromptTextMode
  variants: number
}

export type WhiteboardImageGenerationStartResult = {
  accepted: boolean
  error?: string
}

export type WhiteboardImageGenerationDelivery = {
  paths: string[]
  requestId: string
}

export type WhiteboardImageGenerationCompletion = {
  error?: string
  requestId: string
}

export function buildWhiteboardImageAgentInstruction(
  request: WhiteboardImageGenerationRequest,
) {
  const references = request.sourceImagePaths
    .map((path, index) => `Reference image ${index + 1}: @{${path}}`)
  return [
    'Complete this Kition Whiteboard Image Studio task.',
    `Generate exactly ${request.variants} image ${request.variants === 1 ? 'variant' : 'variants'} using the image_generation tool and save every result as a workspace image artifact.`,
    'Do not call whiteboard_propose_patch and do not modify the board. The client will place the saved image artifacts on the board after the user reviews them.',
    references.length
      ? 'Use the attached authorized reference image files only for the roles described by the prompt.'
      : 'No reference image is attached.',
    '',
    request.prompt,
    '',
    ...references,
  ].filter(Boolean).join('\n')
}

export { isGeneratedImageArtifact, getGeneratedImageToolOutputPaths } from '@/features/media-generation/lib/generatedImageArtifacts'
