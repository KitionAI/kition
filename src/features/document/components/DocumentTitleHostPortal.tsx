import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Portals `children` into a DOM `host` node created by documentTitleHostExtension.
 * Renders nothing when the host is not yet available (e.g., editor still mounting).
 */
export function DocumentTitleHostPortal({ host, children }: { host: HTMLElement | null; children: ReactNode }) {
  if (!host) return null
  return createPortal(children, host)
}
