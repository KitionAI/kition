/**
 * Public entry of the media-generation feature for other features. Import
 * from here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export { ImageStudio, type ImageStudioGenerationState } from './components/ImageStudio'
export {
  getGeneratedImageToolOutputPaths,
  isGeneratedImageArtifact,
} from './lib/generatedImageArtifacts'
export type {
  ImageStudioContext,
  ImageGenerationReceiver,
  ImageStudioPlacementOptions,
  ImageStudioRequest,
  ImageStudioStartResult,
} from './lib/imageStudioTypes'
export type { ImagePromptAspectRatio } from './lib/imagePromptTemplates'
