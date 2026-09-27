import { useCallback, useEffect, useRef, useState } from 'react'

import type { WhiteboardAgentBridge } from '@/features/whiteboard/public'
import { runtimeSupportsWhiteboard } from '@/features/whiteboard/public'
import { getDesktopBackendStatus } from '@/services/desktop'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

/**
 * Registry of the whiteboard editors' Agent bridges, keyed by board path.
 * Each open board registers a bridge that can build Agent context from the
 * canvas and receive patches back; this hook routes Agent events to the
 * right board and reports whether the runtime supports whiteboard tools.
 */
export function useWorkspaceWhiteboardAgentBridge({ rootPath }: { rootPath: string }) {
  const [available, setAvailable] = useState(false)
  const bridgesRef = useRef<Record<string, WhiteboardAgentBridge>>({})
  // Assigned during render by the workspace screen once the active tab is known.
  const activeBoardPathRef = useRef('')

  useEffect(() => {
    let cancelled = false
    void getDesktopBackendStatus()
      .then((status) => {
        if (!cancelled) setAvailable(runtimeSupportsWhiteboard(status?.capabilities))
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const setActiveBoardPath = useCallback((path: string) => {
    activeBoardPathRef.current = path
  }, [])

  const handleBridgeChange = useCallback((path: string, bridge: WhiteboardAgentBridge | null) => {
    if (bridge) {
      bridgesRef.current[path] = bridge
    } else {
      delete bridgesRef.current[path]
    }
  }, [])

  /** Agent context for the active board, or undefined when no board is active. */
  const buildActiveContext = useCallback(() => (
    bridgesRef.current[activeBoardPathRef.current]?.buildContext()
  ), [])

  const receivePatch = useCallback(({ boardPath, patch, provisional }: {
    boardPath: string
    patch: AgentWhiteboardPatch
    provisional: boolean
  }) => {
    if (!available) return
    const bridge = bridgesRef.current[boardPath] || bridgesRef.current[activeBoardPathRef.current]
    bridge?.receivePatch(patch, provisional)
  }, [available])

  const cancelPreview = useCallback(({ boardPath }: { boardPath: string }) => {
    bridgesRef.current[boardPath]?.cancelPreview()
  }, [])

  return {
    available,
    bridgesRef,
    setActiveBoardPath,
    handleBridgeChange,
    buildActiveContext,
    receivePatch,
    cancelPreview,
  }
}
