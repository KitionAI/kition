import { useCallback, useEffect, useRef } from 'react'

import { useScenarioBuild } from '@/features/scenario/hooks/useScenarioBuild'

import { ScenarioBuildPage } from './ScenarioBuildPage'
import { ScenarioStartPage } from './ScenarioStartPage'

export interface ScenarioRouteProps {
  /**
   * Called when the user backs out of the build view. The wrapper has
   * already called `reset()` on the hook by the time this fires, so the host
   * shell only needs to dispose its own state.
   */
  onExit: () => void
}

/**
 * The /scenario route. Owns the `useScenarioBuild` hook and switches between
 * the start (idle) view and the build (streaming/done/error) view based on
 * the hook's status.
 *
 * On unmount (e.g. host shell navigates away mid-build) we call `reset()`
 * which aborts any in-flight SSE stream. We do NOT call onExit on unmount —
 * that's a downstream concern, since unmount means the host already moved on.
 */
export function ScenarioRoute({ onExit }: ScenarioRouteProps) {
  const {
    events,
    status,
    baseId,
    baseName,
    error,
    submit,
    reset,
  } = useScenarioBuild()

  const resetRef = useRef(reset)
  useEffect(() => {
    resetRef.current = reset
  }, [reset])

  useEffect(() => {
    return () => {
      // Abort in-flight stream when the route unmounts.
      resetRef.current()
    }
  }, [])

  const handleSubmit = useCallback(
    async (prompt: string, files: File[]) => {
      try {
        await submit(prompt, files)
      } catch {
        // The hook handles its own error state — swallow so the start page
        // can re-enable its button.
      }
    },
    [submit],
  )

  const handleClose = useCallback(() => {
    reset()
    onExit()
  }, [onExit, reset])

  const showBuildView = status !== 'idle' && status !== 'aborted'

  if (showBuildView) {
    return (
      <ScenarioBuildPage
        events={events}
        status={status}
        baseId={baseId}
        baseName={baseName}
        error={error}
        onClose={handleClose}
      />
    )
  }

  return <ScenarioStartPage onSubmit={handleSubmit} />
}
