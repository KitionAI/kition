import { FileSpreadsheet, FileText, FolderPlus, Upload, Zap } from 'lucide-react'
import { type CSSProperties, type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { documentCreateFormatOptions, type DocumentCreateFormat } from '@/features/document/lib/documentCreation'

type WorkspaceCreateMenuVariant = 'workspace' | 'kitable'
type WorkspaceCreateMenuPlacement = 'top' | 'bottom'

// Estimated dimensions for off-screen detection. Real menu size depends on
// content/fonts but these are close enough to pick a side without flicker.
const ESTIMATED_MENU_WIDTH = 192
const ESTIMATED_MENU_HEIGHT = 200

export function WorkspaceCreateMenu({
  open,
  variant = 'workspace',
  placement = 'bottom',
  anchorEl,
  onCreateFolder,
  onCreateDocument,
  onCreateTable,
  onCreateWorkflow,
  onImportFromDialog,
}: {
  open: boolean
  variant?: WorkspaceCreateMenuVariant
  placement?: WorkspaceCreateMenuPlacement
  /** When provided, the menu portals to <body> and floats at the trigger's
   *  bottom-right so it escapes the sidebar's overflow-hidden
   *  box. Without it the menu falls back to inline absolute positioning so
   *  legacy callers keep working unchanged. */
  anchorEl?: HTMLElement | null
  onCreateFolder: () => void
  onCreateDocument: (format: DocumentCreateFormat) => void
  onCreateTable: () => void
  /** Kitable variant only — adds a "Create Workflow" entry that defers to
   *  the table picker / mode dialog the same way the legacy "..." menu
   *  entry did. Undefined hides the option so non-kitable callers stay
   *  unchanged. */
  onCreateWorkflow?: () => void
  onImportFromDialog?: () => void
}) {
  const { t } = useTranslation('workspace')
  const coords = useAnchoredMenuCoords(open, anchorEl ?? null)

  if (!open) {
    return null
  }

  const content: ReactNode = variant === 'kitable' ? (
    // Inside a .kitable the inline `+` menu creates tables and — when the
    // caller wires onCreateWorkflow — also defers to the workflow table
    // picker / mode dialog, so all "spawn something inside this kitable"
    // affordances live on the same trigger.
    <>
      <button
        type="button"
        className="document-create-option"
        onClick={onCreateTable}
      >
        <FileSpreadsheet className="size-4" />
        <span>{t('createMenu.newTable')}</span>
      </button>
      {onCreateWorkflow ? (
        <button
          type="button"
          className="document-create-option"
          data-testid="kitable-action-create-workflow"
          onClick={onCreateWorkflow}
        >
          <Zap className="size-4" />
          <span>{t('createMenu.newWorkflow')}</span>
        </button>
      ) : null}
    </>
  ) : (
    <>
      {documentCreateFormatOptions.map((item) => {
        const FormatIcon = resolveWorkspaceCreateIcon(item.value)
        return (
          <button
            key={item.value}
            type="button"
            className="document-create-option"
            onClick={() => {
              if (item.value === 'table') {
                onCreateTable()
                return
              }
              onCreateDocument(item.value)
            }}
          >
            <FormatIcon className="size-4" />
            <span>{t('createMenu.format.' + item.value)}</span>
          </button>
        )
      })}
      <button
        type="button"
        className="document-create-option"
        onClick={onCreateFolder}
      >
        <FolderPlus className="size-4" />
        <span>{t('createMenu.folder')}</span>
      </button>
      {onImportFromDialog ? (
        <button
          type="button"
          className="document-create-option"
          onClick={onImportFromDialog}
        >
          <Upload className="size-4" />
          <span>{t('createMenu.importFile')}</span>
        </button>
      ) : null}
    </>
  )

  if (anchorEl !== undefined) {
    if (!coords) {
      return null
    }
    // The portaled menu still needs the `.document-create-menu-anchor` class so
    // the sidebar's click-outside guard (which uses `.closest()`) treats clicks
    // on menu items as inside the anchor and does not close mid-click.
    const portalStyle: CSSProperties = {
      position: 'fixed',
      left: coords.left,
      top: coords.top,
      right: 'auto',
      bottom: 'auto',
    }
    return createPortal(
      <div
        className="document-create-menu document-create-menu-anchor document-create-menu--portal"
        data-placement={placement}
        style={portalStyle}
      >
        {content}
      </div>,
      document.body,
    )
  }

  return (
    <span className="document-create-menu" data-placement={placement}>
      {content}
    </span>
  )
}

function resolveWorkspaceCreateIcon(format: DocumentCreateFormat) {
  if (format === 'table') {
    return FileSpreadsheet
  }
  return FileText
}

// Anchored menu placement: pin the top-left of the menu near the
// trigger's bottom-right corner, clamp to viewport instead of flipping to
// the left (flipping would put the menu back over the file tree).
export function useAnchoredMenuCoords(
  open: boolean,
  anchorEl: HTMLElement | null,
  options?: { gap?: number; estimatedHeight?: number; estimatedWidth?: number },
) {
  const gap = options?.gap ?? 8
  const estimatedHeight = options?.estimatedHeight ?? ESTIMATED_MENU_HEIGHT
  const estimatedWidth = options?.estimatedWidth ?? ESTIMATED_MENU_WIDTH
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setCoords(null)
      return
    }
    const update = () => {
      const rect = anchorEl.getBoundingClientRect()
      const desiredLeft = rect.right + gap
      const desiredTop = rect.bottom + gap / 2
      const maxLeft = window.innerWidth - estimatedWidth - 8
      const left = Math.max(8, Math.min(desiredLeft, maxLeft))
      let top = desiredTop
      if (top + estimatedHeight > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - estimatedHeight - 8)
      }
      setCoords({ left, top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorEl, gap, estimatedHeight, estimatedWidth])

  return coords
}
