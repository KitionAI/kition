import {
  ArrowUpRight,
  ChevronUp,
  Eraser,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  StickyNote,
  Type,
} from 'lucide-react'
import type { ChangeEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '@/features/whiteboard/hooks/useWhiteboardEditor'
import type { WhiteboardPoint, WhiteboardTool } from '@/features/whiteboard/lib/whiteboardTypes'
import { cn } from '@/lib/utils'
import { importWorkspaceImageFromFile } from '@/services/desktop'

import {
  WhiteboardShapeIcon,
  WhiteboardShapePalette,
} from './WhiteboardShapePalette'

const TOOLS = [
  { tool: 'select', icon: MousePointer2, shortcut: 'V' },
  { tool: 'hand', icon: Hand, shortcut: 'H' },
  { tool: 'pen', icon: Pencil, shortcut: 'P' },
  { tool: 'highlight', icon: Highlighter, shortcut: 'L' },
  { tool: 'eraser', icon: Eraser, shortcut: 'E' },
  { tool: 'connector', icon: ArrowUpRight, shortcut: 'C' },
  { tool: 'text', icon: Type, shortcut: 'T' },
  { tool: 'note', icon: StickyNote, shortcut: 'N' },
] as const satisfies ReadonlyArray<{
  tool: WhiteboardTool
  icon: typeof MousePointer2
  shortcut: string
}>

export function WhiteboardToolbar({
  canvasSize,
  controller,
}: {
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
}) {
  const { t } = useTranslation('workspace')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const importSequenceRef = useRef(0)
  const shapeMenuRef = useRef<HTMLDivElement | null>(null)
  const [shapePaletteOpen, setShapePaletteOpen] = useState(false)
  const [importingImage, setImportingImage] = useState(false)
  const [importError, setImportError] = useState('')

  useEffect(() => {
    if (!shapePaletteOpen) return
    function closeOnPointerDown(event: PointerEvent) {
      if (!shapeMenuRef.current?.contains(event.target as Node)) {
        setShapePaletteOpen(false)
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setShapePaletteOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [shapePaletteOpen])

  useEffect(() => {
    if (controller.tool !== 'rectangle') setShapePaletteOpen(false)
  }, [controller.tool])

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportError('')
    setImportingImage(true)
    try {
      importSequenceRef.current += 1
      const [imported, size] = await Promise.all([
        importWorkspaceImageFromFile({
          file,
          folder: 'Attachments',
          index: importSequenceRef.current,
        }),
        readImagePlacementSize(file),
      ])
      controller.insertImage({
        alt: file.name,
        canvasSize,
        height: size.height,
        width: size.width,
        workspacePath: imported.importedPath,
      })
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('board.imageImport.error'))
    } finally {
      setImportingImage(false)
    }
  }

  return (
    <>
      <div
        className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-background/95 p-1.5 shadow-[var(--shadow-toolbar)] backdrop-blur"
        role="toolbar"
        aria-label={t('board.toolbar.label')}
        data-testid="whiteboard-toolbar"
      >
        {TOOLS.map(({ tool, icon: Icon, shortcut }) => {
          const label = t(`board.toolbar.${tool}`)
          return (
            <ToolButton
              key={tool}
              active={controller.tool === tool}
              label={`${label} (${shortcut})`}
              testId={`whiteboard-tool-${tool}`}
              onClick={() => {
                setShapePaletteOpen(false)
                controller.setTool(tool)
              }}
            >
              <Icon className="size-4" />
            </ToolButton>
          )
        })}
        <span className="whiteboard-toolbar-separator" aria-hidden="true" />
        <ToolButton
          active={false}
          disabled={importingImage}
          label={t('board.toolbar.image')}
          testId="whiteboard-tool-image"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImageIcon className="size-4" />
        </ToolButton>
        <div ref={shapeMenuRef} className="relative flex items-center">
          <ToolButton
            active={controller.tool === 'rectangle'}
            label={`${t(`board.shapes.${controller.shapeType}`)} (R)`}
            testId="whiteboard-tool-rectangle"
            onClick={() => {
              controller.selectShapeType(controller.shapeType)
              setShapePaletteOpen(false)
            }}
          >
            <WhiteboardShapeIcon shapeType={controller.shapeType} />
          </ToolButton>
          <button
            type="button"
            className={cn(
              'flex h-9 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              shapePaletteOpen && 'bg-accent text-accent-foreground',
            )}
            onClick={() => setShapePaletteOpen((open) => !open)}
            aria-label={t('board.toolbar.moreShapes')}
            aria-haspopup="menu"
            aria-expanded={shapePaletteOpen}
            title={t('board.toolbar.moreShapes')}
            data-testid="whiteboard-shape-menu-trigger"
          >
            <ChevronUp className="size-4" />
          </button>
          {shapePaletteOpen ? (
            <WhiteboardShapePalette
              selected={controller.shapeType}
              onSelect={(shapeType) => {
                controller.selectShapeType(shapeType)
                setShapePaletteOpen(false)
              }}
            />
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif"
          onChange={handleImageChange}
          aria-label={t('board.toolbar.image')}
          data-testid="whiteboard-image-input"
        />
      </div>

      {importError ? (
        <div
          className="whiteboard-image-import-error absolute left-1/2 z-30 -translate-x-1/2 rounded-lg border border-destructive-border bg-destructive-background px-3 py-2 text-xs text-destructive shadow-[var(--shadow-toolbar)]"
          role="alert"
        >
          {t('board.imageImport.error')}: {importError}
        </div>
      ) : null}

      <WhiteboardZoomControls controller={controller} canvasSize={canvasSize} />
    </>
  )
}

function ToolButton({
  active,
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
  active: boolean
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:bg-muted disabled:text-muted-foreground',
        active && 'bg-accent text-accent-foreground hover:bg-accent',
      )}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

function WhiteboardZoomControls({
  canvasSize,
  controller,
}: {
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
}) {
  const { t } = useTranslation('workspace')
  const center = { x: canvasSize.x / 2, y: canvasSize.y / 2 }
  return (
    <div
      className="absolute bottom-4 left-4 z-20 flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      data-testid="whiteboard-zoom-controls"
    >
      <ZoomButton label={t('board.toolbar.zoomOut')} onClick={() => controller.zoomBy(1 / 1.2, center)}>
        <Minus className="size-4" />
      </ZoomButton>
      <span className="whiteboard-zoom-label text-center text-xs font-medium text-muted-foreground">
        {Math.round(controller.viewport.zoom * 100)}%
      </span>
      <ZoomButton label={t('board.toolbar.zoomIn')} onClick={() => controller.zoomBy(1.2, center)}>
        <Plus className="size-4" />
      </ZoomButton>
      <span className="whiteboard-toolbar-separator" aria-hidden="true" />
      <ZoomButton
        label={t('board.toolbar.fit')}
        onClick={() => controller.fitToContent(canvasSize)}
        testId="whiteboard-fit"
      >
        <Maximize2 className="size-4" />
      </ZoomButton>
    </div>
  )
}

function ZoomButton({
  children,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

async function readImagePlacementSize(file: File) {
  const fallback = { width: 320, height: 220 }
  if (typeof createImageBitmap !== 'function') return fallback
  try {
    const image = await createImageBitmap(file)
    const dimensions = {
      width: image.width || fallback.width,
      height: image.height || fallback.height,
    }
    image.close()
    const scale = Math.min(1, 420 / dimensions.width, 320 / dimensions.height)
    return {
      width: Math.max(80, dimensions.width * scale),
      height: Math.max(60, dimensions.height * scale),
    }
  } catch {
    return fallback
  }
}
