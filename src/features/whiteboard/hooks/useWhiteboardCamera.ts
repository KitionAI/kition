import { useCallback, useState } from 'react'

import {
  clampWhiteboardZoom,
  getWhiteboardContentBounds,
  screenToWhiteboardPoint,
} from '../lib/whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'

export const DEFAULT_WHITEBOARD_VIEWPORT: WhiteboardViewport = {
  x: 0,
  y: 0,
  zoom: 1,
}

export function useWhiteboardCamera(elements: readonly WhiteboardElement[]) {
  const [viewport, setViewport] = useState<WhiteboardViewport>(
    DEFAULT_WHITEBOARD_VIEWPORT,
  )

  const zoomBy = useCallback((factor: number, anchor: WhiteboardPoint) => {
    setViewport((current) => {
      const worldAnchor = screenToWhiteboardPoint(anchor, current)
      const zoom = clampWhiteboardZoom(current.zoom * factor)
      return {
        zoom,
        x: worldAnchor.x - anchor.x / zoom,
        y: worldAnchor.y - anchor.y / zoom,
      }
    })
  }, [])

  const fitToContent = useCallback((size: WhiteboardPoint) => {
    const bounds = getWhiteboardContentBounds(elements)
    if (!bounds || size.x <= 0 || size.y <= 0) {
      setViewport(DEFAULT_WHITEBOARD_VIEWPORT)
      return
    }
    const margin = 96
    const width = Math.max(bounds.width, 1)
    const height = Math.max(bounds.height, 1)
    const zoom = clampWhiteboardZoom(Math.min(
      Math.max(1, size.x - margin * 2) / width,
      Math.max(1, size.y - margin * 2) / height,
    ))
    setViewport({
      zoom,
      x: bounds.x - (size.x / zoom - width) / 2,
      y: bounds.y - (size.y / zoom - height) / 2,
    })
  }, [elements])

  const replaceViewport = useCallback((next: WhiteboardViewport) => {
    setViewport(next)
  }, [])

  return {
    fitToContent,
    replaceViewport,
    setViewport,
    viewport,
    zoomBy,
  }
}
