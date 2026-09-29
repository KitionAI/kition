import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ImageGenerationReceiver,
  ImageStudioContext,
  ImageStudioGenerationState,
  ImageStudioPlacementOptions,
  ImageStudioRequest,
  ImageStudioStartResult,
} from '@/features/media-generation/public'
import { existingDesignImage } from '../lib/designAssets'
import { placeGeneratedImageInDesign } from '../lib/designImageGeneration'
import type { DesignSession } from '../lib/designSession'
import type { DesignStore } from '../lib/designStore'

const EMPTY_CONTEXT: ImageStudioContext = { selectionText: '', sourceImagePaths: [] }

/**
 * State for the design image studio: open and close, forward a request to
 * the workspace, accept artifacts back through the bridge, and place a
 * chosen result on the artboard.
 */
export function useDesignImageStudio({
  session,
  store,
  onGenerateImage,
  onError,
}: {
  session: DesignSession
  store: DesignStore
  onGenerateImage?: (request: ImageStudioRequest) => Promise<ImageStudioStartResult>
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation('imageGeneration')
  const [open, setOpen] = useState(false)
  const [context, setContext] = useState<ImageStudioContext>(EMPTY_CONTEXT)
  const [generation, setGeneration] = useState<ImageStudioGenerationState>({ paths: [], status: 'idle' })

  const openStudio = useCallback(() => {
    const { document, selection } = store.getSnapshot()
    const selectionText = selection
      .map((id) => document.nodes[id])
      .filter((node) => node?.type === 'text')
      .map((node) => node.text.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000)
    const sourceImagePaths = selection
      .map((id) => document.nodes[id])
      .filter((node) => node?.type === 'image' && node.assetId)
      .map((node) => document.assets[node.assetId!]?.path)
      .filter((path): path is string => Boolean(path))
    setContext({ selectionText, sourceImagePaths })
    setGeneration({ paths: [], status: 'idle' })
    setOpen(true)
  }, [store])

  const start = useCallback(
    async (request: ImageStudioRequest): Promise<ImageStudioStartResult> => {
      setGeneration({ paths: [], requestId: request.requestId, status: 'submitting' })
      const result = onGenerateImage
        ? await onGenerateImage(request)
        : { accepted: false, error: t('errors.unavailable') }
      if (!result.accepted) {
        setGeneration({ error: result.error, paths: [], requestId: request.requestId, status: 'error' })
      }
      return result
    },
    [onGenerateImage, t],
  )

  const receiver = useMemo<ImageGenerationReceiver>(
    () => ({
      receiveImageGenerationArtifacts: (delivery) =>
        setGeneration((current) => {
          if (current.requestId !== delivery.requestId) return current
          return { ...current, paths: Array.from(new Set([...current.paths, ...delivery.paths])), status: 'ready' }
        }),
      completeImageGeneration: (completion) =>
        setGeneration((current) => {
          if (current.requestId !== completion.requestId) return current
          if (current.paths.length) return { ...current, status: 'ready' }
          return { ...current, error: completion.error || t('errors.noResult'), status: 'error' }
        }),
    }),
    [t],
  )

  const addResult = useCallback(
    async (path: string, options: ImageStudioPlacementOptions) => {
      try {
        const asset = await existingDesignImage(session.root, path)
        const placed = placeGeneratedImageInDesign(store.getSnapshot().document, asset, options)
        store.commit(placed.document)
        store.select(placed.nodeIds)
      } catch (error) {
        onError(error)
      }
    },
    [onError, session.root, store],
  )

  const addAll = useCallback(
    async (paths: string[], options: ImageStudioPlacementOptions) => {
      for (const path of paths) await addResult(path, options)
    },
    [addResult],
  )

  return { open, close: () => setOpen(false), openStudio, context, generation, start, receiver, addResult, addAll }
}
