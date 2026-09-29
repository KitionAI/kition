import type {
  ImagePromptAspectRatio,
  ImagePromptTemplateId,
  ImagePromptTextMode,
} from './imagePromptTemplates'

/** What the host knows about the selection when the studio opens. */
export type ImageStudioContext = {
  replaceElementId?: string
  selectionText: string
  sourceImagePaths: string[]
}

/** What the studio asks the Agent to generate, for any target surface. */
export type ImageStudioRequest = {
  aspectRatio: ImagePromptAspectRatio
  exactText?: string
  prompt: string
  quality: 'low' | 'medium' | 'high'
  replaceElementId?: string
  requestId: string
  resolution: '1K' | '2K' | '4K'
  sourceImagePaths: string[]
  /** Workspace path of the board or design the results belong to. */
  targetPath: string
  templateId: ImagePromptTemplateId
  textMode: ImagePromptTextMode
  variants: number
}

export type ImageStudioStartResult = {
  accepted: boolean
  error?: string
}

export type ImageStudioPlacementOptions = {
  aspectRatio: ImagePromptAspectRatio
  exactText: string
  textMode: ImagePromptTextMode
}

type ImageGenerationDelivery = {
  paths: string[]
  requestId: string
}

type ImageGenerationCompletion = {
  error?: string
  requestId: string
}

/** The hooks an editor exposes so generated artifacts can reach its studio. */
export type ImageGenerationReceiver = {
  completeImageGeneration?: (completion: ImageGenerationCompletion) => void
  receiveImageGenerationArtifacts?: (delivery: ImageGenerationDelivery) => void
}
