import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ImagePromptAspectRatio,
  ImagePromptTextMode,
} from '@/features/media-generation/lib/imagePromptTemplates'
import { WhiteboardAgentPreviewControls } from '@/features/whiteboard/components/WhiteboardAgentPreview'
import { WhiteboardAgentScopeControl } from '@/features/whiteboard/components/WhiteboardAgentScopeControl'
import { WhiteboardCanvas } from '@/features/whiteboard/components/WhiteboardCanvas'
import {
  WhiteboardImageStudio,
  type WhiteboardImageStudioContext,
  type WhiteboardImageStudioGenerationState,
} from '@/features/whiteboard/components/WhiteboardImageStudio'
import { WhiteboardSelectionToolbar } from '@/features/whiteboard/components/WhiteboardSelectionToolbar'
import { WhiteboardMinimap } from '@/features/whiteboard/components/WhiteboardMinimap'
import { WhiteboardToolbar } from '@/features/whiteboard/components/WhiteboardToolbar'
import { WhiteboardStylePanel } from '@/features/whiteboard/components/WhiteboardStylePanel'
import { WhiteboardTopActions } from '@/features/whiteboard/components/WhiteboardTopActions'
import { useWhiteboardAgentPatch } from '@/features/whiteboard/hooks/useWhiteboardAgentPatch'
import { useBoardDocument } from '@/features/whiteboard/hooks/useBoardDocument'
import { useWhiteboardEditor } from '@/features/whiteboard/hooks/useWhiteboardEditor'
import { buildWhiteboardAgentContext, type WhiteboardAgentScope } from '@/features/whiteboard/lib/whiteboardAgentContext'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import {
  buildEditableImageTextOverlay,
  getEditableImageTextOverlay,
  getGeneratedImageCenters,
  getGeneratedImagePlacementSize,
} from '@/features/whiteboard/lib/whiteboardGeneratedImages'
import type {
  WhiteboardImageGenerationRequest,
  WhiteboardImageGenerationStartResult,
} from '@/features/whiteboard/lib/whiteboardImageGeneration'
import type { WhiteboardPoint } from '@/features/whiteboard/lib/whiteboardTypes'
import {
  cloneWhiteboardTestRecords,
  installWhiteboardTestBridge,
} from '@/features/whiteboard/testing/whiteboardTestBridge'
import { useTranslation } from 'react-i18next'

import './whiteboard.css'

export function WhiteboardEditorPane({
  agentAvailable = false,
  agentBusy = false,
  onAgentBridgeChange,
  onCancelAgent,
  onGenerateImage,
  onOpenAgent,
  path,
  title,
}: {
  agentAvailable?: boolean
  agentBusy?: boolean
  onAgentBridgeChange?: (path: string, bridge: WhiteboardAgentBridge | null) => void
  onCancelAgent?: () => void
  onGenerateImage?: (request: WhiteboardImageGenerationRequest) => Promise<WhiteboardImageGenerationStartResult>
  onOpenAgent?: () => void
  path: string
  title: string
}) {
  const { t } = useTranslation('workspace')
  const { t: ti } = useTranslation('imageGeneration')
  const controller = useWhiteboardEditor()
  const agentPatch = useWhiteboardAgentPatch({
    commands: controller.commands,
    store: controller.store,
  })
  const documentState = useBoardDocument({
    path,
    title,
    isTransacting: controller.isTransacting,
    records: controller.records,
    viewport: controller.viewport,
    replaceDocument: controller.replaceDocument,
  })
  const [canvasSize, setCanvasSize] = useState<WhiteboardPoint>({ x: 1200, y: 760 })
  const [agentScope, setAgentScope] = useState<WhiteboardAgentScope>('viewport')
  const [imageStudioOpen, setImageStudioOpen] = useState(false)
  const [imageStudioContext, setImageStudioContext] = useState<WhiteboardImageStudioContext>({
    selectionText: '',
    sourceImagePaths: [],
  })
  const [imageGeneration, setImageGeneration] = useState<WhiteboardImageStudioGenerationState>({
    paths: [],
    status: 'idle',
  })
  const handleSizeChange = useCallback((size: WhiteboardPoint) => {
    setCanvasSize((current) => (
      current.x === size.x && current.y === size.y ? current : size
    ))
  }, [])

  useEffect(() => {
    if (agentScope === 'selection' && !controller.hasSelection) {
      setAgentScope('viewport')
    }
  }, [agentScope, controller.hasSelection])

  useEffect(() => {
    if (imageGeneration.status === 'submitting' && agentBusy) {
      setImageGeneration((current) => ({ ...current, status: 'generating' }))
    }
  }, [agentBusy, imageGeneration.status])

  const openImageStudio = useCallback(() => {
    const selectionText = controller.selectedElements
      .flatMap((element) => (
        element.kind === 'rectangle' || element.kind === 'text'
          ? [element.text?.trim() || '']
          : []
      ))
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000)
    const selectedImages = controller.selectedElements.filter((element) => (
      element.kind === 'image'
    ))
    const replaceTarget = controller.selectedElements.length === 1
      && (controller.selectedElements[0]?.kind === 'image'
        || (controller.selectedElements[0]?.kind === 'rectangle'
          && controller.selectedElements[0].shapeStyle === 'image-placeholder'))
      ? controller.selectedElements[0]
      : undefined
    setImageStudioContext({
      replaceElementId: replaceTarget?.id,
      selectionText,
      sourceImagePaths: selectedImages.map((element) => element.workspacePath),
    })
    setImageGeneration({ paths: [], status: 'idle' })
    setImageStudioOpen(true)
  }, [controller.selectedElements])

  const startImageGeneration = useCallback(async (
    request: WhiteboardImageGenerationRequest,
  ) => {
    setImageGeneration({ paths: [], requestId: request.requestId, status: 'submitting' })
    if (!onGenerateImage) {
      const result = { accepted: false, error: ti('errors.unavailable') }
      setImageGeneration({
        error: result.error,
        paths: [],
        requestId: request.requestId,
        status: 'error',
      })
      return result
    }
    const result = await onGenerateImage(request)
    if (!result.accepted) {
      setImageGeneration({
        error: result.error,
        paths: [],
        requestId: request.requestId,
        status: 'error',
      })
    }
    return result
  }, [onGenerateImage, ti])

  const agentBridge = useMemo<WhiteboardAgentBridge>(() => ({
    available: agentAvailable,
    buildContext: () => agentAvailable
      ? buildWhiteboardAgentContext({
          activeStyle: controller.activeStyle,
          canvasSize,
          path,
          scope: agentScope,
          selectedElementIds: controller.selectedElementIds,
          store: controller.store,
          title,
          tool: controller.tool,
          viewport: controller.viewport,
        }) || undefined
      : undefined,
    cancelPreview: agentPatch.cancel,
    completeImageGeneration: (completion) => {
      setImageGeneration((current) => {
        if (current.requestId !== completion.requestId) return current
        if (current.paths.length) return { ...current, status: 'ready' }
        return {
          ...current,
          error: completion.error || ti('errors.noResult'),
          status: 'error',
        }
      })
    },
    receiveImageGenerationArtifacts: (delivery) => {
      setImageGeneration((current) => {
        if (current.requestId !== delivery.requestId) return current
        return {
          ...current,
          paths: Array.from(new Set([...current.paths, ...delivery.paths])),
          status: 'ready',
        }
      })
    },
    receivePatch: (patch, provisional) => {
      if (agentAvailable) agentPatch.receivePatch(patch, provisional)
    },
  }), [
    agentAvailable,
    agentPatch.cancel,
    agentPatch.receivePatch,
    agentScope,
    controller.activeStyle,
    canvasSize,
    controller.selectedElementIds,
    controller.store,
    controller.tool,
    controller.viewport,
    path,
    title,
    ti,
  ])

  useEffect(() => {
    onAgentBridgeChange?.(path, agentBridge)
    return () => onAgentBridgeChange?.(path, null)
  }, [agentBridge, onAgentBridgeChange, path])

  useEffect(() => installWhiteboardTestBridge(() => ({
    activeStyle: { ...controller.activeStyle },
    canRedo: controller.canRedo,
    canUndo: controller.canUndo,
    currentPageId: controller.currentPageId,
    interactionState: controller.interactionState,
    path,
    records: cloneWhiteboardTestRecords(controller.records),
    selectedElementIds: [...controller.selectedElementIds],
    shapeType: controller.shapeType,
    tool: controller.tool,
    viewport: { ...controller.viewport },
  })), [
    controller.activeStyle,
    controller.canRedo,
    controller.canUndo,
    controller.currentPageId,
    controller.interactionState,
    controller.records,
    controller.selectedElementIds,
    controller.shapeType,
    controller.tool,
    controller.viewport,
    path,
  ])

  const cancelAgentPreview = useCallback(() => {
    agentPatch.cancel()
    if (agentBusy) onCancelAgent?.()
  }, [agentBusy, agentPatch, onCancelAgent])
  const askAgentAboutSelection = useCallback(() => {
    setAgentScope('selection')
    onOpenAgent?.()
  }, [onOpenAgent])

  const placeGeneratedImage = useCallback((
    workspacePath: string,
    options: {
      aspectRatio: ImagePromptAspectRatio
      exactText: string
      textMode: ImagePromptTextMode
    },
    replace: boolean,
    center?: WhiteboardPoint,
  ) => {
    const size = getGeneratedImagePlacementSize(options.aspectRatio)
    const image = controller.insertImage({
      alt: options.exactText || ti('generatedImageAlt'),
      canvasSize,
      center,
      height: size.height,
      replaceElementId: replace ? imageStudioContext.replaceElementId : undefined,
      width: size.width,
      workspacePath,
    })
    const existingOverlay = getEditableImageTextOverlay(controller.elements, image.id)
    if (options.textMode === 'editable_overlay' && options.exactText) {
      const overlay = buildEditableImageTextOverlay({
        elements: controller.elements,
        image,
        text: options.exactText,
      })
      if (overlay) {
        controller.commands.execute({
          type: overlay.existing ? 'element.update' : 'element.create',
          elements: [overlay.element],
        })
        controller.replaceSelection([overlay.element.id])
      }
    } else if (replace && existingOverlay) {
      controller.commands.execute({
        type: 'element.delete',
        elementIds: [existingOverlay.id],
      })
    }
  }, [canvasSize, controller, imageStudioContext.replaceElementId, ti])

  const addAllGeneratedImages = useCallback((
    paths: string[],
    options: {
      aspectRatio: ImagePromptAspectRatio
      exactText: string
      textMode: ImagePromptTextMode
    },
  ) => {
    const size = getGeneratedImagePlacementSize(options.aspectRatio)
    const centers = getGeneratedImageCenters({
      canvasSize,
      count: paths.length,
      imageSize: size,
      viewport: controller.viewport,
    })
    paths.slice(0, centers.length).forEach((workspacePath, index) => {
      placeGeneratedImage(workspacePath, options, false, centers[index])
    })
  }, [canvasSize, controller.viewport, placeGeneratedImage])

  return (
    <div
      className="relative h-full min-h-0 w-full bg-background"
      data-testid="whiteboard-editor-pane"
      data-board-path={path}
    >
      <WhiteboardCanvas
        agentPreview={agentPatch.state.preview}
        canvasSize={canvasSize}
        controller={controller}
        onSizeChange={handleSizeChange}
        title={title}
      />
      <WhiteboardTopActions
        canvasSize={canvasSize}
        controller={controller}
        onOpenImageStudio={openImageStudio}
        title={title}
      />
      <WhiteboardToolbar
        controller={controller}
        canvasSize={canvasSize}
      />
      <WhiteboardSelectionToolbar
        agentAvailable={agentAvailable}
        controller={controller}
        onAskAgent={askAgentAboutSelection}
        onOpenImageStudio={openImageStudio}
      />
      <WhiteboardMinimap canvasSize={canvasSize} controller={controller} />
      <WhiteboardStylePanel controller={controller} />
      <WhiteboardAgentScopeControl
        available={agentAvailable}
        hasSelection={controller.hasSelection}
        onChange={setAgentScope}
        value={agentScope}
      />
      <WhiteboardAgentPreviewControls
        state={agentPatch.state}
        onAccept={() => void agentPatch.accept()}
        onCancel={cancelAgentPreview}
        onReject={agentPatch.reject}
      />
      <WhiteboardImageStudio
        available={agentAvailable && Boolean(onGenerateImage)}
        boardPath={path}
        context={imageStudioContext}
        generation={imageGeneration}
        onAddAll={addAllGeneratedImages}
        onAddResult={(workspacePath, options) => {
          const index = Math.max(0, imageGeneration.paths.indexOf(workspacePath))
          const centers = getGeneratedImageCenters({
            canvasSize,
            count: imageGeneration.paths.length || 1,
            imageSize: getGeneratedImagePlacementSize(options.aspectRatio),
            viewport: controller.viewport,
          })
          placeGeneratedImage(workspacePath, options, false, centers[index])
        }}
        onClose={() => setImageStudioOpen(false)}
        onGenerate={startImageGeneration}
        onReplaceResult={(workspacePath, options) => placeGeneratedImage(workspacePath, options, true)}
        open={imageStudioOpen}
      />
      <div
        className="absolute bottom-4 right-4 z-20 rounded-md border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-[var(--shadow-toolbar)] backdrop-blur"
        role={documentState.status === 'error' ? 'alert' : 'status'}
        title={documentState.error || undefined}
        data-testid="board-save-status"
      >
        {t(`board.status.${documentState.status}`)}
      </div>
    </div>
  )
}
