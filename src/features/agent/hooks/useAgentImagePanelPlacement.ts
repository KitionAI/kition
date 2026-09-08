import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

const EDGE = 12
const GAP = 12
const MAX_WIDTH = 760
const MAX_HEIGHT = 780

/** Keep the image browser beside the conversation, with an overlay on smaller windows. */
export function useAgentImagePanelPlacement(open: boolean, trigger: RefObject<HTMLButtonElement | null>) {
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() })
  const [layout, setLayout] = useState({ width: MAX_WIDTH, height: MAX_HEIGHT, overlay: false, x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const panel = trigger.current?.closest<HTMLElement>('.agent-chat-panel')
    if (!panel) return
    const update = () => {
      const bounds = panel.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = window.innerHeight
      const availableLeft = bounds.left - GAP - EDGE
      const overlay = viewportWidth < 1024 || availableLeft < 480
      const width = Math.min(MAX_WIDTH, overlay ? viewportWidth - EDGE * 2 : availableLeft)
      const height = Math.min(MAX_HEIGHT, viewportHeight - EDGE * 2, overlay ? viewportHeight : bounds.height)
      const x = overlay ? (viewportWidth - width) / 2 : bounds.left
      const y = overlay ? (viewportHeight - height) / 2 : Math.min(bounds.bottom, viewportHeight - EDGE) - height
      const rect = new DOMRect(x, y, 0, overlay ? 0 : height)
      anchor.current = { getBoundingClientRect: () => rect }
      setLayout((current) => current.width === width && current.height === height
        && current.overlay === overlay && current.x === x && current.y === y
        ? current : { width, height, overlay, x, y })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    observer.observe(document.documentElement)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [open, trigger])

  return { anchor, ...layout }
}
