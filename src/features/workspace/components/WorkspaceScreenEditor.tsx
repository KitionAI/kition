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
    <WorkspaceEditorPane>
      <WorkspaceEditorContent {...editorContentProps} />
    </WorkspaceEditorPane>
  )
}
