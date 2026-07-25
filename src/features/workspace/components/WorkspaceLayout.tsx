import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { handleDesktopChromeDoubleClick } from '@/lib/windowChrome'

export function WorkspaceLayout({
  sidebar,
  sidebarFooter,
  sidebarWidth,
  rightPane,
  rightPaneWidth,
  editorClassName,
  editor,
  onResizeSidebar,
  onResizeRightPane,
}: {
  sidebar: ReactNode
  sidebarFooter?: ReactNode
  sidebarWidth: number
  rightPane?: ReactNode
  rightPaneWidth?: number
  editorClassName?: string
  editor: ReactNode
  onResizeSidebar: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onResizeRightPane?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation('workspace')
  return (
    <div
      className={cn('document-workspace', rightPane && 'has-right-pane')}
      style={{
        '--document-sidebar-width': `${sidebarWidth}px`,
        ...(rightPaneWidth
          ? { '--workspace-agent-sidebar-width': `${rightPaneWidth}px` }
          : {}),
      } as CSSProperties}
    >
      <aside className="document-sidebar">
        <div
          className="document-sidebar-titlebar"
          onDoubleClick={handleDesktopChromeDoubleClick}
          aria-hidden="true"
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {sidebar}
        </div>
        {sidebarFooter ? (
          <div className="document-agent-section">
            {sidebarFooter}
          </div>
        ) : null}
      </aside>
      <button
        type="button"
        className="document-sidebar-resizer"
        style={{ left: `${sidebarWidth - 4}px`, display: sidebarWidth <= 0 ? 'none' : undefined }}
        onPointerDown={onResizeSidebar}
        aria-label={t('layout.resizeSidebar')}
        aria-orientation="vertical"
        data-window-drag-exclude="true"
      />
      <section className={cn('document-editor-panel flex min-h-0 flex-col overflow-hidden', editorClassName)}>
        {editor}
      </section>
      {rightPane ? <div className="document-right-pane">{rightPane}</div> : null}
      {rightPane && onResizeRightPane && rightPaneWidth ? (
        <button
          type="button"
          className="document-right-pane-resizer"
          style={{ right: `${rightPaneWidth - 4}px` }}
          onPointerDown={onResizeRightPane}
          aria-label={t('layout.resizeChat')}
          aria-orientation="vertical"
          data-window-drag-exclude="true"
        />
      ) : null}
    </div>
  )
}
