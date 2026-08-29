import { useCallback, useState } from 'react'
import type { SetStateAction } from 'react'

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

const MAX_CAMERA_HISTORY = 50

type WhiteboardCameraState = {
  viewport: WhiteboardViewport
  past: WhiteboardViewport[]
  future: WhiteboardViewport[]
}

export function useWhiteboardCamera(elements: readonly WhiteboardElement[]) {
  const [camera, setCamera] = useState<WhiteboardCameraState>({
    viewport: DEFAULT_WHITEBOARD_VIEWPORT,
    past: [],
    future: [],
  })

  const setViewport = useCallback((action: SetStateAction<WhiteboardViewport>) => {
    setCamera((current) => ({
      ...current,
      viewport: resolveViewportAction(action, current.viewport),
    }))
  }, [])

  const commitViewport = useCallback((action: SetStateAction<WhiteboardViewport>) => {
    setCamera((current) => {
      const viewport = resolveViewportAction(action, current.viewport)
      if (whiteboardViewportsEqual(viewport, current.viewport)) return current
      return {
        viewport,
        past: [...current.past, current.viewport].slice(-MAX_CAMERA_HISTORY),
        future: [],
      }
    })
  }, [])

  const zoomBy = useCallback((factor: number, anchor: WhiteboardPoint) => {
    commitViewport((current) => {
      const worldAnchor = screenToWhiteboardPoint(anchor, current)
      const zoom = clampWhiteboardZoom(current.zoom * factor)
      return {
        zoom,
        x: worldAnchor.x - anchor.x / zoom,
        y: worldAnchor.y - anchor.y / zoom,
      }
    })
  }, [commitViewport])

  const panBy = useCallback((delta: WhiteboardPoint) => {
    setViewport((current) => ({
      ...current,
      x: current.x + delta.x / current.zoom,
      y: current.y + delta.y / current.zoom,
    }))
  }, [setViewport])

  const fitToElements = useCallback((
    targetElements: readonly WhiteboardElement[],
    size: WhiteboardPoint,
  ) => {
    const bounds = getWhiteboardContentBounds(targetElements)
    if (!bounds || size.x <= 0 || size.y <= 0) {
      commitViewport(DEFAULT_WHITEBOARD_VIEWPORT)
      return
    }
    const margin = 96
    const width = Math.max(bounds.width, 1)
    const height = Math.max(bounds.height, 1)
    const zoom = clampWhiteboardZoom(Math.min(
      Math.max(1, size.x - margin * 2) / width,
      Math.max(1, size.y - margin * 2) / height,
    ))
    commitViewport({
      zoom,
      x: bounds.x - (size.x / zoom - width) / 2,
      y: bounds.y - (size.y / zoom - height) / 2,
    })
  }, [commitViewport])

  const fitToContent = useCallback((size: WhiteboardPoint) => {
    fitToElements(elements, size)
  }, [elements, fitToElements])

  const centerViewportAt = useCallback((
    point: WhiteboardPoint,
    size: WhiteboardPoint,
  ) => {
    commitViewport((current) => ({
      ...current,
      x: point.x - size.x / current.zoom / 2,
      y: point.y - size.y / current.zoom / 2,
    }))
  }, [commitViewport])

  const actualSize = useCallback((size: WhiteboardPoint) => {
    commitViewport((current) => {
      const center = {
        x: current.x + size.x / current.zoom / 2,
        y: current.y + size.y / current.zoom / 2,
      }
      return {
        x: center.x - size.x / 2,
        y: center.y - size.y / 2,
        zoom: 1,
      }
    })
  }, [commitViewport])

  const replaceViewport = useCallback((next: WhiteboardViewport) => {
    setCamera({ viewport: next, past: [], future: [] })
  }, [])

  const recordViewportHistory = useCallback((previous: WhiteboardViewport) => {
    setCamera((current) => {
      if (whiteboardViewportsEqual(previous, current.viewport)) return current
      return {
        ...current,
        past: [...current.past, previous].slice(-MAX_CAMERA_HISTORY),
        future: [],
      }
    })
  }, [])

  const cameraBack = useCallback(() => {
    setCamera((current) => {
      const viewport = current.past.at(-1)
      if (!viewport) return current
      return {
        viewport,
        past: current.past.slice(0, -1),
        future: [current.viewport, ...current.future].slice(0, MAX_CAMERA_HISTORY),
      }
    })
  }, [])

  const cameraForward = useCallback(() => {
    setCamera((current) => {
      const viewport = current.future[0]
      if (!viewport) return current
      return {
        viewport,
        past: [...current.past, current.viewport].slice(-MAX_CAMERA_HISTORY),
        future: current.future.slice(1),
      }
    })
  }, [])

  return {
    actualSize,
    cameraBack,
    cameraForward,
    canCameraBack: camera.past.length > 0,
    canCameraForward: camera.future.length > 0,
    centerViewportAt,
    fitToContent,
    fitToElements,
    panBy,
    replaceViewport,
    recordViewportHistory,
    setViewport,
    viewport: camera.viewport,
    zoomBy,
  }
}

function resolveViewportAction(
  action: SetStateAction<WhiteboardViewport>,
  current: WhiteboardViewport,
) {
  return typeof action === 'function' ? action(current) : action
}

function whiteboardViewportsEqual(
  left: WhiteboardViewport,
  right: WhiteboardViewport,
) {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom
}
