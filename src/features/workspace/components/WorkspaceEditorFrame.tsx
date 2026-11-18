import { WorkspaceScreenEditor, type WorkspaceScreenEditorInput } from '@/features/workspace/components/WorkspaceScreenEditor'

type WorkspaceEditorFrameProps = {
  editor: WorkspaceScreenEditorInput
}

/** The editor column: the active pane. */
export function WorkspaceEditorFrame({ editor }: WorkspaceEditorFrameProps) {
  return (
    <div className="workspace-editor-frame">
      <div className="workspace-editor-frame__content">
        <WorkspaceScreenEditor {...editor} />
      </div>
    </div>
  )
}
