import { useEffect } from 'react'
import type { ImageGenerationReceiver } from '@/features/media-generation/public'
import { buildDesignAgentContext } from '../lib/designAgentContext'
import type { DesignAgentBridge } from '../lib/designAgentBridge'
import type { DesignSession } from '../lib/designSession'
import type { DesignStore } from '../lib/designStore'

/** Registers this editor's bridge with the workspace while the agent is available. */
export function useDesignAgentBridge({
  agentAvailable,
  onAgentBridgeChange,
  session,
  store,
  receivePatch,
  cancelPreview,
  receiver,
}: {
  agentAvailable: boolean
  onAgentBridgeChange?: (path: string, bridge: DesignAgentBridge | null) => void
  session: DesignSession
  store: DesignStore
  receivePatch: DesignAgentBridge['receivePatch']
  cancelPreview: DesignAgentBridge['cancelPreview']
  receiver: ImageGenerationReceiver
}) {
  useEffect(() => {
    if (!agentAvailable || !onAgentBridgeChange) return
    const bridge: DesignAgentBridge = {
      buildContext: () =>
        buildDesignAgentContext({
          document: store.getSnapshot().document,
          path: session.path,
          selection: store.getSnapshot().selection,
        }) ?? undefined,
      receivePatch,
      cancelPreview,
      ...receiver,
    }
    onAgentBridgeChange(session.path, bridge)
    return () => onAgentBridgeChange(session.path, null)
  }, [agentAvailable, onAgentBridgeChange, session.path, store, receivePatch, cancelPreview, receiver])
}
