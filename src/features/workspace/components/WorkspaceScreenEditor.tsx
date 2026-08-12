import type { ComponentProps } from 'react'

import { WorkspaceEditorContent } from './WorkspaceEditorContent'
import { WorkspaceEditorPane } from './WorkspaceEditorPane'

type WorkspaceScreenEditorProps = {
  editorContentProps: ComponentProps<typeof WorkspaceEditorContent>
}

export function WorkspaceScreenEditor({
  editorContentProps,
}: WorkspaceScreenEditorProps) {
  return (
    <div className="workspace-screen-editor flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <WorkspaceEditorPane>
        <WorkspaceEditorContent {...editorContentProps} />
      </WorkspaceEditorPane>
    </div>
  )
}
