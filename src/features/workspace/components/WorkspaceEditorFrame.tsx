import type { ReactNode } from 'react'

import { WorkspaceScreenEditor, type WorkspaceScreenEditorInput } from '@/features/workspace/components/WorkspaceScreenEditor'

type WorkspaceEditorFrameProps = {
  /** Full-screen workflow workbench; replaces the editor while open. */
  workbench: ReactNode
  editor: WorkspaceScreenEditorInput
}

/** The editor column: the active pane, or the workflow workbench while it is open. */
export function WorkspaceEditorFrame({ workbench, editor }: WorkspaceEditorFrameProps) {
  return (
    <div className="workspace-editor-frame">
      <div className="workspace-editor-frame__content">
        {workbench || <WorkspaceScreenEditor {...editor} />}
      </div>
    </div>
  )
}
