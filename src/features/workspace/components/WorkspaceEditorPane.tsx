import type { ReactNode } from 'react'

export function WorkspaceEditorPane({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="document-editor-surface" data-testid="document-editor">
        {children}
      </div>
    </div>
  )
}
