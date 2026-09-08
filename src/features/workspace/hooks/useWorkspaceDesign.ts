import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createDesignFile } from '@/features/design/lib/designFile'
import { createDesign } from '@/features/design/lib/designTypes'
import {
  existingDesignImage,
  insertDesignImage,
} from '@/features/design/lib/designAssets'
import { placeImageInDesign } from '@/features/design/lib/designImageTargets'
import { DESIGN_IMAGE_ACTION } from '@/services/workspaceDesignActions'
import { notify } from '@/lib/notify'
import { getWorkspaceItemTitle, type WorkspaceTab } from '../lib/workspace'
export function useWorkspaceDesign(options: {
  root: string
  activeTab: WorkspaceTab | null
  upsert: (tab: WorkspaceTab) => void
  refresh: (
    path?: string,
    options?: { silent?: boolean; treeOnly?: boolean },
  ) => Promise<boolean>
  closeCreateMenu: () => void
  expandFolder: (paths: string[]) => void
  beforeOpen: () => void
}) {
  const { t } = useTranslation('design'),
    current = useRef(options)
  current.current = options
  const open = useCallback((path: string) => {
    current.current.beforeOpen()
    current.current.upsert({
      id: `design:${path}`,
      type: 'design',
      title: getWorkspaceItemTitle(path.split('/').pop() || path),
      path,
    })
  }, [])
  const create = useCallback(
    async (folder = '') => {
      const captured = current.current
      captured.closeCreateMenu()
      try {
        const file = await createDesignFile(captured.root, folder)
        if (current.current.root !== captured.root) return
        if (folder) captured.expandFolder([folder])
        await captured.refresh(undefined, { silent: true, treeOnly: true })
        if (current.current.root === captured.root) open(file.path)
      } catch (error) {
        notify.error(t('errors.create'), { description: String(error) })
      }
    },
    [open, t],
  )
  useEffect(() => {
    const handler = (event: Event) => {
      const { path, createNew } = (
        event as CustomEvent<{ path: string; createNew?: boolean }>
      ).detail
      const captured = current.current,
        target =
          !createNew && captured.activeTab?.type === 'design'
            ? captured.activeTab.path
            : null
      void (async () => {
        try {
          const asset = await existingDesignImage(captured.root, path)
          if (current.current.root !== captured.root) return
          if (target) {
            placeImageInDesign(captured.root, target, asset)
            notify.success(t('imageAdded'))
            return
          }
          const title = getWorkspaceItemTitle(path.split('/').pop() || 'Design')
          const document = insertDesignImage(
            createDesign(title),
            asset,
            true,
          ).document
          document.provenance = { imagePath: path }
          const file = await createDesignFile(captured.root, '', document)
          if (current.current.root !== captured.root) return
          await captured.refresh(undefined, { silent: true, treeOnly: true })
          if (current.current.root === captured.root) open(file.path)
        } catch (error) {
          notify.error(t('errors.image'), { description: String(error) })
        }
      })()
    }
    window.addEventListener(DESIGN_IMAGE_ACTION, handler)
    return () => window.removeEventListener(DESIGN_IMAGE_ACTION, handler)
  }, [open, t])
  const chatEmptyState = {
    description: t('chat.description'),
    suggestions: (['headline', 'palette', 'background'] as const).map(
      (key) => ({
        label: t(`chat.${key}.label`),
        prompt: t(`chat.${key}.prompt`),
      }),
    ),
  }
  return { open, create, chatEmptyState }
}
