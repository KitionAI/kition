import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  clampAgentSidebarWidth,
  clampWorkspaceSidebarWidth,
  readAgentSidebarWidth,
  readWorkspaceSidebarWidth,
  writeAgentSidebarWidth,
  writeWorkspaceSidebarWidth,
} from '@/features/workspace/lib/workspacePersistence'
import type { WorkspaceMediaKind } from '@/features/workspace/lib/workspace'

type WorkspaceSidebarSection = 'private' | WorkspaceMediaKind
export type EditorTextStyle = 'default' | 'serif' | 'mono'
export type EditorMode = 'rich' | 'split' | 'source' | 'preview'

export type EditorViewPreferences = {
  editorMode: EditorMode
  textStyle: EditorTextStyle
  smallText: boolean
  fullWidth: boolean
  toc: boolean
  locked: boolean
}

const editorDefaultViewPreferences: EditorViewPreferences = {
  editorMode: 'rich',
  textStyle: 'default',
  smallText: false,
  fullWidth: false,
  toc: false,
  locked: false,
}

export const editorTextStyleOptions: Array<{ value: EditorTextStyle; label: string; sample: string }> = [
  { value: 'default', label: 'Default', sample: 'Ag' },
  { value: 'serif', label: 'Serif', sample: 'Ag' },
  { value: 'mono', label: 'Mono', sample: 'Ag' },
]

export function useWorkspaceChrome() {
  const [workspaceSidebarWidth, setWorkspaceSidebarWidth] = useState(() => readWorkspaceSidebarWidth())
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(() => readAgentSidebarWidth())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editorView, setEditorView] = useState<EditorViewPreferences>(editorDefaultViewPreferences)
  const [itemMenuOpen, setItemMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [sidebarSectionsExpanded, setSidebarSectionsExpanded] = useState<Record<WorkspaceSidebarSection, boolean>>({
    private: true,
    images: false,
    videos: false,
  })

  const effectiveSidebarWidth = sidebarCollapsed ? 0 : workspaceSidebarWidth

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-sidebar-width',
      `${effectiveSidebarWidth}px`,
    )
    document.documentElement.dataset.sidebarCollapsed = sidebarCollapsed
      ? 'true'
      : 'false'
  }, [effectiveSidebarWidth, sidebarCollapsed])

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => !current)
  }, [])

  const toggleSidebarSection = useCallback((section: WorkspaceSidebarSection) => {
    setSidebarSectionsExpanded((current) => ({
      ...current,
      [section]: !current[section],
    }))
  }, [])

  const toggleEditorPreference = useCallback((key: keyof Omit<EditorViewPreferences, 'textStyle'>) => {
    setEditorView((current) => ({
      ...current,
      [key]: !current[key],
    }))
  }, [])

  const handleWorkspaceSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = workspaceSidebarWidth
    let nextWidth = startWidth
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(pointerEvent: PointerEvent) {
      nextWidth = clampWorkspaceSidebarWidth(startWidth + pointerEvent.clientX - startX)
      setWorkspaceSidebarWidth(nextWidth)
      document.documentElement.style.setProperty('--app-sidebar-width', `${nextWidth}px`)
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      writeWorkspaceSidebarWidth(nextWidth)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }, [workspaceSidebarWidth])

  const handleAgentSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = agentSidebarWidth
    let nextWidth = startWidth
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(pointerEvent: PointerEvent) {
      nextWidth = clampAgentSidebarWidth(startWidth - (pointerEvent.clientX - startX))
      setAgentSidebarWidth(nextWidth)
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      writeAgentSidebarWidth(nextWidth)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }, [agentSidebarWidth])

  return {
    agentSidebarWidth,
    editorView,
    effectiveSidebarWidth,
    handleAgentSidebarResize,
    handleWorkspaceSidebarResize,
    itemMenuOpen,
    setEditorView,
    setItemMenuOpen,
    setSidebarSectionsExpanded,
    setWorkspaceMenuOpen,
    sidebarCollapsed,
    sidebarSectionsExpanded,
    toggleEditorPreference,
    toggleSidebarCollapsed,
    toggleSidebarSection,
    workspaceMenuOpen,
    workspaceSidebarWidth,
  }
}
