import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { loadDesignLib } from '@/features/design/public'
import {
  DESIGN_FROM_BOARD_ACTION,
  DESIGN_FROM_RECORD_ACTION,
  DESIGN_IMAGE_ACTION,
  DESIGN_INSERT_DOCUMENT_ACTION,
  DESIGN_SEND_TABLE_ACTION,
  type DesignDocumentInsertRequest,
  type DesignImageRequest,
  type DesignRecordRequest,
  type DesignTableSendRequest,
} from '@/services/workspaceDesignActions'
import { relativeMarkdownPath } from '@/features/document/public'
import { listDataRecords, updateDataRecord, uploadDataAttachment } from '@/api/dataDocuments'
import { designMarkdownLink, sendDesignToTable } from '../lib/designHandoff'
import type { DesignDocument } from '@/features/design/public'
import type { BoardFrameSnapshot } from '@/types/designStart'
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
        const { createDesignFile } = await loadDesignLib()
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
  /** Writes a new design file in the workspace root and opens it. */
  const createFrom = useCallback(
    async (build: (lib: Awaited<ReturnType<typeof loadDesignLib>>) => Promise<DesignDocument>) => {
      const captured = current.current
      try {
        const lib = await loadDesignLib()
        const document = await build(lib)
        if (current.current.root !== captured.root) return
        const file = await lib.createDesignFile(captured.root, '', document)
        if (current.current.root !== captured.root) return
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
      const { path, createNew, headline } = (event as CustomEvent<DesignImageRequest>).detail
      const captured = current.current,
        target =
          !createNew && captured.activeTab?.type === 'design'
            ? captured.activeTab.path
            : null
      void (async () => {
        try {
          const { existingDesignImage, placeImageInDesign } = await loadDesignLib()
          const asset = await existingDesignImage(captured.root, path)
          if (current.current.root !== captured.root) return
          if (target) {
            placeImageInDesign(captured.root, target, asset)
            notify.success(t('imageAdded'))
            return
          }
          const title = getWorkspaceItemTitle(path.split('/').pop() || 'Design')
          await createFrom(async ({ designFromImage }) => designFromImage(asset, { title, headline }))
        } catch (error) {
          notify.error(t('errors.image'), { description: String(error) })
        }
      })()
    }
    window.addEventListener(DESIGN_IMAGE_ACTION, handler)
    return () => window.removeEventListener(DESIGN_IMAGE_ACTION, handler)
  }, [createFrom, t])
  useEffect(() => {
    const fromRecord = (event: Event) => {
      const { title, fields, record } = (event as CustomEvent<DesignRecordRequest>).detail
      const root = current.current.root
      void createFrom(async ({ designFromRecord, loadDesignTemplatePackage, loadWorkspaceBrandKit, brandKitBindings }) => {
        const [pack, kit] = await Promise.all([loadDesignTemplatePackage(), loadWorkspaceBrandKit(root)])
        const entry = pack.templates.find(({ resource }) => resource.id === pack.manifest.defaultResourceId) ?? pack.templates[0]
        if (!entry) throw new Error('No design template is available')
        return designFromRecord(entry.template, fields, { brand: brandKitBindings(kit), title, record })
      })
    }
    const fromBoard = (event: Event) => {
      const frame = (event as CustomEvent<BoardFrameSnapshot>).detail
      const root = current.current.root
      void createFrom(async ({ designFromBoardFrame, existingDesignImage }) =>
        designFromBoardFrame(frame, (workspacePath) => existingDesignImage(root, workspacePath)),
      )
    }
    window.addEventListener(DESIGN_FROM_RECORD_ACTION, fromRecord)
    window.addEventListener(DESIGN_FROM_BOARD_ACTION, fromBoard)
    return () => {
      window.removeEventListener(DESIGN_FROM_RECORD_ACTION, fromRecord)
      window.removeEventListener(DESIGN_FROM_BOARD_ACTION, fromBoard)
    }
  }, [createFrom])
  // The document the user was on last, for "Insert into document".
  const lastDocumentTab = useRef<Extract<WorkspaceTab, { type: 'document' }> | null>(null)
  if (options.activeTab?.type === 'document' && (options.activeTab.format ?? 'markdown') === 'markdown')
    lastDocumentTab.current = options.activeTab
  useEffect(() => {
    const insert = (event: Event) => {
      const { assetPath, title } = (event as CustomEvent<DesignDocumentInsertRequest>).detail
      const tab = lastDocumentTab.current
      if (!tab) {
        notify.error(t('noDocumentTarget'))
        return
      }
      current.current.upsert(tab)
      const markdown = designMarkdownLink(title, relativeMarkdownPath(tab.path, assetPath))
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('kition:document:insert-markdown', { detail: { path: tab.path, markdown } }),
        )
        notify.success(t('insertedIntoDocument', { title: tab.title }))
      }, 50)
    }
    const send = (event: Event) => {
      const { file, ref } = (event as CustomEvent<DesignTableSendRequest>).detail
      void sendDesignToTable(
        {
          uploadAttachment: uploadDataAttachment,
          readRecordValue: async (target) => {
            const page = await listDataRecords(target.documentId, target.tableId, { limit: 500 })
            return page.items?.find((record) => record.id === target.recordId)?.values?.[target.field]
          },
          updateRecord: (target, values) => updateDataRecord(target.documentId, target.tableId, target.recordId, values),
        },
        ref,
        file,
      )
        .then(() => notify.success(t('sentToTable')))
        .catch((error) => notify.error(t('errors.sendToTable'), { description: String(error) }))
    }
    window.addEventListener(DESIGN_INSERT_DOCUMENT_ACTION, insert)
    window.addEventListener(DESIGN_SEND_TABLE_ACTION, send)
    return () => {
      window.removeEventListener(DESIGN_INSERT_DOCUMENT_ACTION, insert)
      window.removeEventListener(DESIGN_SEND_TABLE_ACTION, send)
    }
  }, [t])
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
