import type { ImageGenerationReceiver } from '@/features/media-generation/public'
import type { AgentDesignContext } from '@/types/designAgent'

/** What an open design editor offers the workspace Agent plumbing. */
export type DesignAgentBridge = ImageGenerationReceiver & {
  buildContext: () => AgentDesignContext | undefined
  receivePatch: (patch: unknown, provisional: boolean) => void
  cancelPreview: () => void
}
