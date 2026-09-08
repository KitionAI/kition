import { useEffect, useState } from 'react'
import type { AgentTurnContext } from '@/features/agent/lib/agentTurnContext'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import { runtimeSupportsAgentImageGeneration } from '@/features/media-generation/lib/imageGenerationCapabilities'
import { getDesktopBackendStatus } from '@/services/desktop'
import type { AgentImageTarget } from '@/types/imageGeneration'

export function captureWorkspaceImageTarget(context?: AgentTurnContext): AgentImageTarget | undefined {
  if (context?.paneContext === 'table') {
    if (!context.activeDataDocumentId || !context.activeDataTableId) return undefined
    return { type: 'image.target.table', data_document_id: context.activeDataDocumentId, table_id: context.activeDataTableId }
  }
  if (context?.paneContext === 'whiteboard') {
    if (!context.activeDocumentPath) return undefined
    return { type: 'image.target.whiteboard', board_path: context.activeDocumentPath }
  }
  if (context?.paneContext === 'document' && context.activeDocumentPath) {
    return { type: 'image.target.document', document_path: context.activeDocumentPath }
  }
  return undefined
}

export function useWorkspaceImageGeneration(rootPath: string, context?: AgentTurnContext) {
  const { settings } = useDesktopSettings()
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let canceled = false
    setAvailable(false)
    let checking = false
    const refresh = async () => {
      if (checking || canceled) return
      checking = true
      try {
        const status = await getDesktopBackendStatus()
        if (!canceled) setAvailable(runtimeSupportsAgentImageGeneration(status?.capabilities))
      } catch {
        if (!canceled) setAvailable(false)
      } finally {
        checking = false
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 10000)
    return () => {
      canceled = true
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }, [rootPath])
  return {
    available,
    accessToken: settings.providers.kition_console?.accessToken || undefined,
    target: captureWorkspaceImageTarget(context),
  }
}
