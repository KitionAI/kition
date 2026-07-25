import type { ComponentProps } from 'react'
import { useMemo } from 'react'
import { WorkspaceMediaPanel } from '@/features/workspace/components/WorkspaceMediaPanel'
import { isAgentProviderConfigurationError } from '@/features/agent/lib/agentConfig'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocumentTreeItem } from '@/services/desktop'

type UseWorkspaceEditorPanelsOptions = {
  activeWorkspaceTab: WorkspaceTab | undefined
  error: string
  imageFiles: WorkspaceDocumentTreeItem[]
  onOpenDocument: (path: string) => Promise<void>
  videoFiles: WorkspaceDocumentTreeItem[]
}

export function useWorkspaceEditorPanels({
  activeWorkspaceTab,
  error,
  imageFiles,
  onOpenDocument,
  videoFiles,
}: UseWorkspaceEditorPanelsOptions) {
  const activeGalleryFiles = useMemo(
    () => activeWorkspaceTab?.type === 'gallery'
      ? activeWorkspaceTab.kind === 'images' ? imageFiles : videoFiles
      : [],
    [activeWorkspaceTab, imageFiles, videoFiles],
  )

  const agentNeedsModelConfig = useMemo(
    () => isAgentProviderConfigurationError(error),
    [error],
  )

  const galleryPanelProps = useMemo<ComponentProps<typeof WorkspaceMediaPanel> | null>(() => {
    if (activeWorkspaceTab?.type !== 'gallery') {
      return null
    }

    return {
      files: activeGalleryFiles,
      kind: activeWorkspaceTab.kind,
      onOpen: (path) => void onOpenDocument(path),
    }
  }, [activeGalleryFiles, activeWorkspaceTab, onOpenDocument])

  return {
    agentNeedsModelConfig,
    galleryPanelProps,
  }
}
