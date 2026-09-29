import type { AgentDesignContext } from '@/types/designAgent'

/** What an open design editor offers the workspace Agent plumbing. */
export type DesignAgentBridge = {
  buildContext: () => AgentDesignContext | undefined
  receivePatch: (patch: unknown, provisional: boolean) => void
  cancelPreview: () => void
}
