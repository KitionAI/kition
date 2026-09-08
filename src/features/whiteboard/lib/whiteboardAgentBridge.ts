import type {
  AgentWhiteboardContext,
  AgentWhiteboardPatch,
} from '@/types/whiteboardAgent'
import type {
  WhiteboardImageGenerationCompletion,
  WhiteboardImageGenerationDelivery,
} from './whiteboardImageGeneration'

export type WhiteboardAgentBridge = {
  available: boolean
  buildContext: () => AgentWhiteboardContext | undefined
  cancelPreview: () => void
  completeImageGeneration?: (completion: WhiteboardImageGenerationCompletion) => void
  receiveImageGenerationArtifacts?: (delivery: WhiteboardImageGenerationDelivery) => void
  receivePatch: (patch: AgentWhiteboardPatch, provisional: boolean) => void
}
