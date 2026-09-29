import { useCallback, useEffect, useRef, useState } from 'react'

import type { DesignAgentBridge } from '@/features/design/public'
import { runtimeSupportsDesignAgent } from '@/features/design/public'
import { getDesktopBackendStatus } from '@/services/desktop'

/**
 * Registry of the design editors' Agent bridges, keyed by file path. Each
 * open design registers a bridge that builds Agent context from the artboard
 * and receives patches back; this hook routes Agent events to the right
 * design and reports whether the runtime supports design patches.
 */
export function useWorkspaceDesignAgentBridge({ rootPath }: { rootPath: string }) {
  const [available, setAvailable] = useState(false)
  const bridgesRef = useRef<Record<string, DesignAgentBridge>>({})
  // Assigned during render by the workspace screen once the active tab is known.
  const activePathRef = useRef('')

  useEffect(() => {
    let cancelled = false
    void getDesktopBackendStatus()
      .then((status) => {
        if (!cancelled) setAvailable(runtimeSupportsDesignAgent(status?.capabilities))
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const setActiveDesignPath = useCallback((path: string) => {
    activePathRef.current = path
  }, [])

  const handleBridgeChange = useCallback((path: string, bridge: DesignAgentBridge | null) => {
    if (bridge) bridgesRef.current[path] = bridge
    else delete bridgesRef.current[path]
  }, [])

  /** Agent context for the active design, or undefined when none is active. */
  const buildActiveContext = useCallback(
    () => bridgesRef.current[activePathRef.current]?.buildContext(),
    [],
  )

  const receivePatch = useCallback(
    ({ designPath, patch, provisional }: { designPath: string; patch: unknown; provisional: boolean }) => {
      if (!available) return
      const bridge = bridgesRef.current[designPath] || bridgesRef.current[activePathRef.current]
      bridge?.receivePatch(patch, provisional)
    },
    [available],
  )

  const cancelPreview = useCallback(({ designPath }: { designPath: string }) => {
    bridgesRef.current[designPath]?.cancelPreview()
  }, [])

  return { available, setActiveDesignPath, handleBridgeChange, buildActiveContext, receivePatch, cancelPreview }
}
