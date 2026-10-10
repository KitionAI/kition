import { useCallback, useEffect, useState } from 'react'
import type { KitChange, KitEngine, RasterDecoration } from '@/features/kits/public'
import { drawCropProposal, drawSelectionAnts } from './photoCanvasTools'

export type CropArea = { x: number; y: number; width: number; height: number }

/**
 * What Photo draws over the image: the selection's marching ants, traced by
 * the engine at the current zoom, and a proposed crop.
 */
export function usePhotoOverlays(doc: KitEngine | null, change: KitChange, hasSelection: boolean, zoom: number | null, crop: CropArea | null) {
  const [segments, setSegments] = useState<Int32Array | null>(null)
  // Trace at display resolution: one sample per screen pixel when zoomed out.
  const step = zoom && zoom < 1 ? Math.max(1, Math.floor(1 / zoom)) : 1

  useEffect(() => {
    if (!doc || !hasSelection) {
      setSegments(null)
      return undefined
    }
    let current = true
    doc.invoke<Int32Array>('selectionOutline', 0, 0, doc.width, doc.height, step).then((next) => {
      if (current) setSegments(next.length ? next : null)
    }, () => undefined)
    return () => {
      current = false
    }
  }, [change.revision, doc, hasSelection, step])

  const decorate = useCallback<RasterDecoration>((context, toScreen) => {
    if (segments) drawSelectionAnts(segments, context, toScreen)
    if (crop && doc) drawCropProposal(crop, context, toScreen, { width: doc.width, height: doc.height })
  }, [crop, doc, segments])

  return { decorate: segments || crop ? decorate : null, animated: Boolean(segments) }
}
