import type { KitCreationItem } from '@/features/workspace/hooks/useKitCreations'
import type { KitCreateGroup } from '@/features/workspace/components/kits/kitEditors'
import { KitIcon } from '@/components/KitIcon'
import { FolderPlusIcon as FolderPlus, ZapIcon as Zap } from '@kition/tessera-icons/react'
import { type CSSProperties, type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

type WorkspaceCreateMenuVariant = 'workspace' | 'tableFile'
type WorkspaceCreateMenuPlacement = 'top' | 'bottom'

// Estimated dimensions for off-screen detection. Real menu size depends on
// content/fonts but these are close enough to pick a side without flicker.
const ESTIMATED_MENU_WIDTH = 192
const ESTIMATED_MENU_HEIGHT = 240
// The workspace menu: four groups in two columns.
const ESTIMATED_GROUPED_MENU_WIDTH = 416
const ESTIMATED_GROUPED_MENU_HEIGHT = 440

/** The workspace menu's groups, by what the new file is for, in menu order. */
const CREATE_GROUPS: readonly KitCreateGroup[] = ['documents', 'data', 'visual', 'media']
/** Item order within the groups. Kition's own file types and the kits mix
 *  freely; a kit not listed here goes last in its group. */
const CREATE_ORDER: readonly string[] = ['note', 'doc', 'pdf', 'design', 'html', 'table', 'sheet', 'slide', 'board', 'design-studio', 'vector', 'photo', 'cad', 'film', 'effect']

type CreateItem = {
  id: string
  group: KitCreateGroup
  label: string
  icon: ReactNode
  /** Shown beside the label when the file is a portable format other apps open. */
  extension?: string
  testId?: string
  onClick: () => void
}

export function WorkspaceCreateMenu({
  open,
  variant = 'workspace',
  placement = 'bottom',
  anchorEl,
  onCreateFolder,
  onCreateDesign,
  kitCreations,
  onCreateWorkflow,
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
  onCreateDesign?: () => void
  /** The create menu's kit items (Image, Video project). */
  kitCreations?: readonly KitCreationItem[]
  /** Table file variant only: a workflow for one of the file's tables. */
  onCreateWorkflow?: () => void
}) {
  const { t } = useTranslation('workspace')
  const grouped = variant === 'workspace'
  const coords = useAnchoredMenuCoords(open, anchorEl ?? null, grouped ? { estimatedWidth: ESTIMATED_GROUPED_MENU_WIDTH, estimatedHeight: ESTIMATED_GROUPED_MENU_HEIGHT } : undefined)

  if (!open) {
    return null
  }

  const createItems: CreateItem[] = [
    ...(onCreateDesign ? [{ id: 'design-studio', group: 'visual', label: t('design:suite'), icon: <KitIcon kit="design" small className="size-4" />, testId: 'workspace-create-design-studio', onClick: onCreateDesign } satisfies CreateItem] : []),
    ...(kitCreations ?? []).map<CreateItem>((kit) => ({
      id: kit.id,
      group: kit.group,
      label: t(kit.label),
      icon: <KitIcon kit={kit.kit} small className="size-4" />,
      extension: portableExtension(kit.extension),
      testId: `workspace-create-${kit.id}`,
      onClick: kit.onCreate,
    })),
  ].sort((a, b) => createRank(a.id) - createRank(b.id))

  const content: ReactNode = variant === 'tableFile' ? (
    // On a table file the inline `+` menu adds a workflow for its tables.
    <>
      {onCreateWorkflow ? (
        <button
          type="button"
          className="document-create-option"
          data-testid="table-file-action-create-workflow"
          onClick={onCreateWorkflow}
        >
          <Zap className="size-4" />
          <span>{t('createMenu.newWorkflow')}</span>
        </button>
      ) : null}
    </>
  ) : (
    // Every file type by what it is for, in two columns; Folder last.
    <>
      {CREATE_GROUPS.map((group) => {
        const items = createItems.filter((item) => item.group === group)
        if (!items.length) return null
        return (
          <CreateMenuGroup key={group} label={t(`createMenu.group.${group}`)}>
            {items.map((item) => (
              <button key={item.id} type="button" className="document-create-option" data-testid={item.testId} onClick={item.onClick}>
                {item.icon}
                <span>{item.label}</span>
                {item.extension ? <span className="document-create-option__format" aria-hidden="true">.{item.extension}</span> : null}
              </button>
            ))}
          </CreateMenuGroup>
        )
      })}
      <div className="document-create-menu__separator" role="separator" />
      <button
        type="button"
        className="document-create-option"
        onClick={onCreateFolder}
      >
        <FolderPlus className="size-4" />
        <span>{t('createMenu.folder')}</span>
      </button>
    </>
  )

  const menuClassName = grouped ? 'document-create-menu document-create-menu--grouped' : 'document-create-menu'

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
        className={`${menuClassName} document-create-menu-anchor document-create-menu--portal`}
        data-placement={placement}
        style={portalStyle}
      >
        {content}
      </div>,
      document.body,
    )
  }

  return (
    <span className={menuClassName} data-placement={placement}>
      {content}
    </span>
  )
}

function CreateMenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="document-create-menu__group" role="group" aria-label={label}>
      <div className="document-create-menu__group-label" aria-hidden="true">{label}</div>
      <div className="document-create-menu__grid">{children}</div>
    </div>
  )
}

function createRank(id: string) {
  const rank = CREATE_ORDER.indexOf(id)
  return rank === -1 ? CREATE_ORDER.length : rank
}

/** Formats other applications open. Kition's own (`.kslide`, `.kdesign`, …) say nothing to a
 *  reader; portable ones (`.docx`, `.psd`) tell Doc from Note. */
const PORTABLE_EXTENSIONS = new Set(['md', 'docx', 'xlsx', 'pptx', 'pdf', 'psd', 'dxf', 'html'])

function portableExtension(extension: string) {
  return PORTABLE_EXTENSIONS.has(extension) ? extension : undefined
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
