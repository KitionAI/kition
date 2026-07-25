import { FileVideo2, Image as ImageIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  formatCompactNumber,
  formatWorkspaceTime,
  getWorkspaceItemFormatLabel,
  getWorkspaceItemTitle,
  inferWorkspaceItemFormat,
  type WorkspaceMediaKind,
} from '@/features/workspace/lib/workspace'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import type { WorkspaceDocumentTreeItem } from '@/services/desktop'

export function WorkspaceMediaPanel({
  files,
  kind,
  onOpen,
}: {
  files: WorkspaceDocumentTreeItem[]
  kind: WorkspaceMediaKind
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation('workspace')
  const isImages = kind === 'images'
  const title = isImages ? t('media.images') : t('media.videos')
  const Icon = isImages ? ImageIcon : FileVideo2

  return (
    <div className="document-media-gallery-panel">
      <div className="document-media-gallery-header">
        <span className="document-media-gallery-icon">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0">
          <h2>{title}</h2>
          <p>{t('media.items', { count: formatCompactNumber(files.length) })}</p>
        </span>
      </div>
      {files.length ? (
        <div className="document-media-gallery-grid">
          {files.map((item) => {
            const itemTitle = getWorkspaceItemTitle(item.name)
            const previewURL = isImages ? resolveWorkspaceFileURL(item.path) : ''
            return (
              <button
                key={item.path}
                type="button"
                className="document-media-gallery-card"
                onClick={() => onOpen(item.path)}
              >
                <span className="document-media-gallery-preview">
                  {previewURL ? (
                    <img
                      alt=""
                      src={previewURL}
                      onError={(event) => {
                        event.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : null}
                  <Icon className="document-media-gallery-fallback size-7" />
                </span>
                <span className="document-media-gallery-card-copy">
                  <strong>{itemTitle}</strong>
                  <small>{item.path}</small>
                  <small>{formatWorkspaceTime(item.updated_at)} · {getWorkspaceItemFormatLabel(item.format || inferWorkspaceItemFormat(item.path))}</small>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 text-center">
          <h3 className="text-base font-semibold">{isImages ? t('media.noImagesTitle') : t('media.noVideosTitle')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {isImages ? t('media.noImagesDescription') : t('media.noVideosDescription')}
          </p>
        </div>
      )}
    </div>
  )
}
