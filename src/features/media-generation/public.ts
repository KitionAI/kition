/**
 * Public entry of the media-generation feature for other features. Import
 * from here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export {
  getGeneratedImageToolOutputPaths,
  isGeneratedImageArtifact,
} from './lib/generatedImageArtifacts'
