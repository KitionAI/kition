import { useEffect, useState } from 'react'
import { ExternalLink, FileText, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openWorkspaceFile, revealWorkspaceFolder } from '@/services/desktop'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import {
  getWorkspaceItemFormatLabel,
  getWorkspaceItemIcon,
  getWorkspaceItemIconColorClass,
  getWorkspaceItemTitle,
} from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/utils'

type WorkspaceFileViewerPaneProps = {
  path: string
  format: WorkspaceDocumentFormat
  active: boolean
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

export function WorkspaceFileViewerPane({ path, format, active }: WorkspaceFileViewerPaneProps) {
  const { t } = useTranslation('workspace')
  const url = resolveWorkspaceFileURL(path)
  const filename = basenameFromPath(path)
  const title = getWorkspaceItemTitle(filename)
  const label = getWorkspaceItemFormatLabel(format)
  const Icon = getWorkspaceItemIcon(format)
  const folderPath = parentFolderFromPath(path)
  const [busy, setBusy] = useState<'open' | 'reveal' | null>(null)

  useEffect(() => {
    setBusy(null)
  }, [path])

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
      <div className="workspace-file-viewer__body">
        {format === 'image' ? (
          <div className="workspace-file-viewer__image">
            <img src={url} alt={filename} loading="lazy" />
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
    </div>
  )
}
