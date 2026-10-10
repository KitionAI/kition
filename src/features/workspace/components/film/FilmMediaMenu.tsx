import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus2 } from 'lucide-react'
import { ActionMenu, ActionMenuContent, ActionMenuItem, ActionMenuLabel, ActionMenuTrigger } from '@/components/ActionMenu'
import { Button } from '@/components/ui'
import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'

const MEDIA = /\.(mp4|mov|m4v|mkv|webm|mxf|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|tiff?)$/i

function mediaFiles(items: readonly WorkspaceDocumentTreeItem[], out: string[] = []) {
  for (const item of items) {
    if (item.type === 'folder') mediaFiles(item.children ?? [], out)
    else if (MEDIA.test(item.path)) out.push(item.path)
  }
  return out
}

/** "Add media": the workspace's video, audio, and image files, added at the playhead. */
export function FilmMediaMenu({ projectPath, onAdd }: { projectPath: string; onAdd: (path: string) => void }) {
  const { t } = useTranslation('workspace')
  const [files, setFiles] = useState<string[] | null>(null)
  return (
    <ActionMenu
      onOpenChange={(open) => {
        if (!open) return
        listWorkspaceDocuments().then((list) => setFiles(mediaFiles(list.items).filter((path) => path !== projectPath)), () => setFiles([]))
      }}
    >
      <ActionMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="film-add-media">
          <FilePlus2 className="size-3.5" aria-hidden="true" />
          {t('filmKit.addMedia')}
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <ActionMenuLabel>{t('filmKit.addMediaHint')}</ActionMenuLabel>
        {files?.length ? files.map((path) => (
          <ActionMenuItem key={path} onSelect={() => onAdd(path)} data-testid={`film-media-${path}`}>
            <span className="truncate">{path}</span>
          </ActionMenuItem>
        )) : <ActionMenuItem disabled>{files ? t('filmKit.noMedia') : t('kitEditor.opening')}</ActionMenuItem>}
      </ActionMenuContent>
    </ActionMenu>
  )
}
