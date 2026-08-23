import type {
  AgentWhiteboardContext,
  AgentWhiteboardPatch,
} from '@/types/whiteboardAgent'

export type WhiteboardAgentBridge = {
  available: boolean
  buildContext: () => AgentWhiteboardContext | undefined
  cancelPreview: () => void
  receivePatch: (patch: AgentWhiteboardPatch, provisional: boolean) => void
}
