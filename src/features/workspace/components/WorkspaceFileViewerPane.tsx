import { requestUseImageInDesign } from '@/services/workspaceDesignActions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Paintbrush, ExternalLink, FileText, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ContextActionMenu } from '@/components/ContextActionMenu'
import { copyImageToClipboard, openWorkspaceFile, revealWorkspaceFolder } from '@/services/desktop'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import {
  getWorkspaceItemFormatLabel,
  getWorkspaceItemIcon,
  getWorkspaceItemIconColorClass,
  getWorkspaceItemTitle,
} from '@/features/workspace/lib/workspace'
import { cn } from '@kition/app-ui/utils'
import { notify } from '@/lib/notify'
import { EditInFilmButton } from './film/EditInFilmButton'
import { KitFilePane } from './kits/KitFilePane'
import { kitEditorFor } from './kits/kitEditors'

type WorkspaceFileViewerPaneProps = {
  path: string
  format: WorkspaceDocumentFormat
  active: boolean
  onOpenAgent?: () => void
}

function basenameFromPath(path: string) {
  const segments = String(path || '').split('/').filter(Boolean)
  return segments[segments.length - 1] || path
}

function parentFolderFromPath(path: string) {
  const segments = String(path || '').split('/').filter(Boolean)
  if (segments.length <= 1) {
    return ''
  }
  return segments.slice(0, -1).join('/')
}

export function WorkspaceFileViewerPane(props: WorkspaceFileViewerPaneProps) {
  const kit = kitEditorFor(props.format)
  if (kit) {
    return <KitFilePane kit={kit} path={props.path} active={props.active} onOpenAgent={props.onOpenAgent} preview={<WorkspaceFilePreview {...props} />} />
  }
  return <WorkspaceFilePreview {...props} />
}

function WorkspaceFilePreview({ path, format, active }: WorkspaceFileViewerPaneProps) {
  const { t } = useTranslation('workspace')
  const url = resolveWorkspaceFileURL(path)
  const filename = basenameFromPath(path)
  const title = getWorkspaceItemTitle(filename)
  const label = getWorkspaceItemFormatLabel(format)
  const Icon = getWorkspaceItemIcon(format)
  const folderPath = parentFolderFromPath(path)
  const [busy, setBusy] = useState<'open' | 'reveal' | 'copy' | null>(null)
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const closeImageMenu = useCallback(() => {
    setImageMenu(null)
    imageRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    setBusy(null)
  }, [path])

  useEffect(() => { setImageMenu(null) }, [path, active])

  const handleCopyImage = async () => {
    try {
      setBusy('copy')
      const copied = await copyImageToClipboard(url)
      if (!copied) throw new Error('Image clipboard write failed')
      notify.success(t('fileViewer.imageCopied'))
    } catch (error) {
      notify.error(t('fileViewer.imageCopyFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const handleOpenExternal = async () => {
    try {
      setBusy('open')
      await openWorkspaceFile(path)
    } finally {
      setBusy(null)
    }
  }

  const handleRevealInFinder = async () => {
    try {
      setBusy('reveal')
      await revealWorkspaceFolder(folderPath || path)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cn('workspace-file-viewer', active && 'is-active')}>
      {format === 'image' ? null : (
        <div className="workspace-file-viewer__toolbar">
          <div className="workspace-file-viewer__title">
            <Icon className={cn('size-4', getWorkspaceItemIconColorClass(format))} aria-hidden="true" />
            <span className="workspace-file-viewer__name">{title || filename}</span>
            <span className="workspace-file-viewer__format-chip">{label}</span>
          </div>
          <div className="workspace-file-viewer__actions">
            {format === 'video' ? <EditInFilmButton path={path} /> : null}
            <button
              type="button"
              className="workspace-file-viewer__action"
              onClick={handleOpenExternal}
              disabled={busy === 'open'}
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span>{t('fileViewer.openInSystem')}</span>
            </button>
            <button
              type="button"
              className="workspace-file-viewer__action"
              onClick={handleRevealInFinder}
              disabled={busy === 'reveal'}
            >
              <FolderOpen className="size-3.5" aria-hidden="true" />
              <span>{t('fileViewer.showInFinder')}</span>
            </button>
          </div>
        </div>
      )}
      {format === 'image' ? <div className="flex justify-end border-b border-border p-2">
        <button type="button" className="workspace-file-viewer__action" onClick={() => requestUseImageInDesign(path, true)}>
          <Paintbrush className="size-4" /><span>{t('design:fromImage')}</span>
        </button>
      </div> : null}
      <div className="workspace-file-viewer__body">
        {format === 'image' ? (
          <div className="workspace-file-viewer__image">
            <img ref={imageRef} src={url} alt={filename} loading="lazy" tabIndex={active ? 0 : -1}
              className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setImageMenu({ x: event.clientX, y: event.clientY })
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                event.stopPropagation()
                const bounds = event.currentTarget.getBoundingClientRect()
                setImageMenu({ x: bounds.left + 16, y: Math.max(8, bounds.top) + 16 })
              }} />
          </div>
        ) : format === 'video' ? (
          <div className="flex h-full items-center justify-center bg-secondary/40 p-6">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- workspace clips carry no caption track */}
            <video src={url} controls preload="metadata" className="max-h-full max-w-full rounded-xl bg-black shadow-sm" data-testid="workspace-video" />
          </div>
        ) : format === 'pdf' ? (
          <iframe
            src={url}
            title={filename}
            className="workspace-file-viewer__iframe"
          />
        ) : (
          <div className="workspace-file-viewer__placeholder">
            <FileText className="size-8" aria-hidden="true" />
            <p className="workspace-file-viewer__placeholder-title">
              {t('fileViewer.previewUnsupported', { label })}
            </p>
            <p className="workspace-file-viewer__placeholder-tip">
              {t('fileViewer.previewTip')}
            </p>
            <p className="workspace-file-viewer__placeholder-path">{path}</p>
          </div>
        )}
      </div>
      {active && format === 'image' && imageMenu ? <ContextActionMenu
        label={t('fileViewer.imageActions')} position={imageMenu} onClose={closeImageMenu}
        items={[{
          id: 'copy-image', label: t('fileViewer.copyImage'), icon: <Copy className="size-4" aria-hidden="true" />,
          disabled: busy === 'copy', onSelect: () => { void handleCopyImage() },
        }]} /> : null}
    </div>
  )
}
