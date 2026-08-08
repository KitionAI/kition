import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  RefreshCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { DataAttachment } from '@/types/dataDocument'
import { copyImageToClipboard, resolvePublicFileURL } from '@/services/desktop'
import { findImageLikeString } from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const SCALE_STEP = 0.25

function resolveAttachment(attachment: DataAttachment | null) {
  if (!attachment) return ''
  const raw = findImageLikeString(attachment)
  return raw ? resolvePublicFileURL(raw) : ''
}

export function AttachmentPreviewModal({
  open,
  items,
  index,
  onClose,
  onIndexChange,
}: {
  open: boolean
  items: DataAttachment[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
}) {
  const { t } = useTranslation('table')
  const total = items.length
  const safeIndex = total > 0 ? ((index % total) + total) % total : 0
  const active = total > 0 ? items[safeIndex] : null

  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 })
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number } | null>(null)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  // Reset transform when target image switches or modal reopens
  useEffect(() => {
    setScale(1)
    setRotation(0)
    setPosition({ x: 0, y: 0 })
    setImageContextMenu(null)
  }, [safeIndex, open])

  // Track displayed image size for pan bounds
  useEffect(() => {
    const img = imageRef.current
    if (!img || !open) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setImgSize({ width, height })
      }
    })
    observer.observe(img)
    return () => observer.disconnect()
  }, [open, safeIndex])

  const constrainPosition = useCallback(
    (p: { x: number; y: number }, s: number) => {
      if (s <= 1 || !imgSize.width || !imgSize.height) return { x: 0, y: 0 }
      const baseW = imgSize.width / s
      const baseH = imgSize.height / s
      const excessW = (baseW * s - baseW) / 2
      const excessH = (baseH * s - baseH) / 2
      return {
        x: Math.max(-excessW, Math.min(excessW, p.x)),
        y: Math.max(-excessH, Math.min(excessH, p.y)),
      }
    },
    [imgSize.width, imgSize.height],
  )

  // Clamp pan when scale shrinks
  useEffect(() => {
    setPosition((prev) => constrainPosition(prev, scale))
  }, [scale, constrainPosition])

  // Wheel zoom (must be non-passive to preventDefault)
  useEffect(() => {
    if (!open) return
    const stage = stageRef.current
    if (!stage) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      setScale((prev) =>
        event.deltaY < 0
          ? Math.min(prev + SCALE_STEP, MAX_SCALE)
          : Math.max(prev - SCALE_STEP, MIN_SCALE),
      )
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [open])

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (imageContextMenu) {
          setImageContextMenu(null)
          return
        }
        onClose()
        return
      }
      if (total <= 1) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        onIndexChange((safeIndex + 1) % total)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onIndexChange((safeIndex - 1 + total) % total)
        return
      }
      if (/^[1-9]$/.test(event.key)) {
        const target = Number(event.key) - 1
        if (target < total) {
          event.preventDefault()
          onIndexChange(target)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [imageContextMenu, open, total, safeIndex, onClose, onIndexChange])

  if (!open || !active || typeof document === 'undefined') return null

  const resolvedSrc = resolveAttachment(active)
  const title = active.name || t('attachment.title')

  function handleZoomIn() {
    setScale((prev) => Math.min(prev + SCALE_STEP, MAX_SCALE))
  }
  function handleZoomOut() {
    setScale((prev) => Math.max(prev - SCALE_STEP, MIN_SCALE))
  }
  function handleRotateCw() {
    setRotation((prev) => (prev + 90) % 360)
  }
  function handleRotateCcw() {
    setRotation((prev) => (prev - 90 + 360) % 360)
  }
  function handleReset() {
    setScale(1)
    setRotation(0)
    setPosition({ x: 0, y: 0 })
  }
  function handleDownload() {
    if (!resolvedSrc) return
    const link = document.createElement('a')
    link.href = resolvedSrc
    link.download = title
    link.rel = 'noreferrer'
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function handleCopyImage() {
    if (!resolvedSrc) return
    setImageContextMenu(null)
    try {
      await copyImageToClipboard(resolvedSrc)
      notify.success(t('attachment.imageCopied'))
    } catch (error) {
      notify.error(t('attachment.imageCopyFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function onMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (scale <= 1) return
    setIsDragging(true)
    dragStartRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    }
  }
  function onMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (!isDragging || scale <= 1) return
    setPosition(
      constrainPosition(
        {
          x: event.clientX - dragStartRef.current.x,
          y: event.clientY - dragStartRef.current.y,
        },
        scale,
      ),
    )
  }
  function endDrag() {
    setIsDragging(false)
  }

  function stopDialogClick(event: ReactMouseEvent<HTMLDivElement>) {
    event.stopPropagation()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 text-white"
      data-testid="attachment-preview-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="flex h-full w-full flex-col"
        data-testid="attachment-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('attachment.previewLabel', { name: title })}
        onMouseDown={stopDialogClick}
      >
        <div
          className="flex h-full w-full flex-col"
          data-testid="attachment-preview-dialog"
          onMouseDown={stopDialogClick}
        >
          <header className="relative flex h-14 shrink-0 items-center justify-center px-16">
            <button
              type="button"
              className="absolute left-4 inline-flex size-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
              data-testid="attachment-preview-download"
              aria-label={t('attachment.download')}
              title={t('attachment.download')}
              onClick={handleDownload}
            >
              <Download className="size-5" aria-hidden />
            </button>
            <span
              className="truncate text-sm font-medium"
              data-testid="attachment-preview-title"
              title={title}
            >
              {title}
            </span>
            <button
              type="button"
              className="absolute right-4 inline-flex size-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
              data-testid="attachment-preview-close"
              aria-label={t('attachment.closePreview')}
              onClick={onClose}
            >
              <X className="size-5" aria-hidden />
            </button>
          </header>

          <div
            ref={stageRef}
            className="relative flex flex-1 select-none items-center justify-center overflow-hidden px-16"
            onMouseDown={() => setImageContextMenu(null)}
          >
            {total > 1 ? (
              <button
                type="button"
                className="absolute left-2 top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
                data-testid="attachment-preview-prev"
                aria-label={t('attachment.previousAttachment')}
                onClick={() => onIndexChange((safeIndex - 1 + total) % total)}
              >
                <ChevronLeft className="size-6" aria-hidden />
              </button>
            ) : null}

            <div
              className={cn(
                'flex h-full w-full items-center justify-center',
                scale > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
              )}
              style={{ touchAction: 'none' }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              {resolvedSrc ? (
                <img
                  ref={imageRef}
                  src={resolvedSrc}
                  alt={title}
                  draggable={false}
                  data-testid="attachment-preview-image"
                  className="max-h-full max-w-full select-none"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setImageContextMenu({
                      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 180)),
                      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 56)),
                    })
                  }}
                  style={{
                    transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
                    transition: isDragging ? 'none' : 'transform 0.2s ease-out',
                  }}
                />
              ) : (
                <div className="rounded-md bg-white/5 px-6 py-4 text-sm text-white/70">
                  {title}
                </div>
              )}
            </div>

            {imageContextMenu ? (
              <div
                className="fixed z-[110] min-w-40 rounded-lg border border-white/15 bg-neutral-900 p-1 shadow-xl"
                style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
                data-testid="attachment-preview-context-menu"
                role="menu"
                onMouseDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                  data-testid="attachment-preview-copy-image"
                  role="menuitem"
                  onClick={() => void handleCopyImage()}
                >
                  <Copy className="size-4" aria-hidden />
                  {t('attachment.copyImage')}
                </button>
              </div>
            ) : null}

            {total > 1 ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
                data-testid="attachment-preview-next"
                aria-label={t('attachment.nextAttachment')}
                onClick={() => onIndexChange((safeIndex + 1) % total)}
              >
                <ChevronRight className="size-6" aria-hidden />
              </button>
            ) : null}

            <div
              className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-black/60 px-3 py-1.5"
              data-testid="attachment-preview-toolbar"
            >
              <button
                type="button"
                className="rounded p-1.5 transition-colors hover:bg-white/10"
                data-testid="attachment-preview-zoom-out"
                aria-label={t('attachment.zoomOut')}
                title={t('attachment.zoomOut')}
                onClick={handleZoomOut}
              >
                <ZoomOut className="size-4" aria-hidden />
              </button>
              <span
                className="min-w-[3rem] text-center text-xs font-medium tabular-nums"
                data-testid="attachment-preview-zoom-percent"
              >
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                className="rounded p-1.5 transition-colors hover:bg-white/10"
                data-testid="attachment-preview-zoom-in"
                aria-label={t('attachment.zoomIn')}
                title={t('attachment.zoomIn')}
                onClick={handleZoomIn}
              >
                <ZoomIn className="size-4" aria-hidden />
              </button>
              <div className="mx-1 h-5 w-px bg-white/20" />
              <button
                type="button"
                className="rounded p-1.5 transition-colors hover:bg-white/10"
                data-testid="attachment-preview-rotate-ccw"
                aria-label={t('attachment.rotateCcw')}
                title={t('attachment.rotateCcw')}
                onClick={handleRotateCcw}
              >
                <RotateCw className="size-4 -scale-x-100" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded p-1.5 transition-colors hover:bg-white/10"
                data-testid="attachment-preview-rotate-cw"
                aria-label={t('attachment.rotateCw')}
                title={t('attachment.rotateCw')}
                onClick={handleRotateCw}
              >
                <RotateCw className="size-4" aria-hidden />
              </button>
              <div className="mx-1 h-5 w-px bg-white/20" />
              <button
                type="button"
                className="rounded p-1.5 transition-colors hover:bg-white/10"
                data-testid="attachment-preview-reset"
                aria-label={t('attachment.reset')}
                title={t('attachment.reset')}
                onClick={handleReset}
              >
                <RefreshCcw className="size-4" aria-hidden />
              </button>
            </div>
          </div>

          {total > 1 ? (
            <footer
              className="flex shrink-0 items-center justify-center gap-2 overflow-x-auto px-6 py-3"
              data-testid="attachment-preview-footer"
            >
              {items.map((item, idx) => {
                const thumbSrc = resolveAttachment(item)
                const isActive = idx === safeIndex
                return (
                  <button
                    key={`${item.url || item.name}-${idx}`}
                    type="button"
                    className={cn(
                      'group h-12 w-12 shrink-0 overflow-hidden rounded-md border-2 transition',
                      isActive
                        ? 'border-white'
                        : 'border-transparent opacity-60 hover:opacity-100',
                    )}
                    data-testid="attachment-preview-thumb"
                    data-active={isActive ? 'true' : 'false'}
                    aria-label={t('attachment.showAttachment', { index: idx + 1 })}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => {
                      if (idx !== safeIndex) onIndexChange(idx)
                    }}
                  >
                    {thumbSrc ? (
                      <img
                        src={thumbSrc}
                        alt={item.name || t('attachment.imageAltIndex', { index: idx + 1 })}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[10px] text-white/70">
                        {idx + 1}
                      </span>
                    )}
                  </button>
                )
              })}
            </footer>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}
