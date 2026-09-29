import {
  ImageStudio,
  type ImageStudioContext,
  type ImageStudioGenerationState,
  type ImageStudioPlacementOptions,
} from '@/features/media-generation/public'
import type {
  WhiteboardImageGenerationRequest,
  WhiteboardImageGenerationStartResult,
} from '../lib/whiteboardImageGeneration'

export type WhiteboardImageStudioContext = ImageStudioContext
export type WhiteboardImageStudioGenerationState = ImageStudioGenerationState

/** The shared image studio bound to one board. */
export function WhiteboardImageStudio({
  boardPath,
  onGenerate,
  ...props
}: {
  available: boolean
  boardPath: string
  context: WhiteboardImageStudioContext
  generation: WhiteboardImageStudioGenerationState
  onAddAll: (paths: string[], options: ImageStudioPlacementOptions) => void
  onAddResult: (path: string, options: ImageStudioPlacementOptions) => void
  onClose: () => void
  onGenerate: (request: WhiteboardImageGenerationRequest) => Promise<WhiteboardImageGenerationStartResult>
  onReplaceResult: (path: string, options: ImageStudioPlacementOptions) => void
  open: boolean
}) {
  return (
    <ImageStudio
      {...props}
      targetPath={boardPath}
      testIdPrefix="whiteboard-image"
      onGenerate={(request) => onGenerate({ ...request, boardPath: request.targetPath })}
    />
  )
}
