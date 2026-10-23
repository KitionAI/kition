import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Tabbable descendants in document order, skipping anything not rendered or hidden from assistive technology. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' &&
      !element.closest('[aria-hidden="true"]') &&
      (typeof element.checkVisibility !== 'function' || element.checkVisibility()),
  )
}

/**
 * Focus management for a dialog that mounts while open. On mount, focus moves to the descendant
 * marked `data-dialog-initial-focus` (a search field, say, rather than a close button that would
 * otherwise be first in tab order and show a focus ring the instant the dialog opens), or else
 * the first tabbable descendant, or the container itself (which must have `tabIndex={-1}`); Tab
 * and Shift+Tab move through the dialog's own tabbable elements and wrap inside; on unmount focus
 * returns to the element that had it before the dialog opened. Every Tab is handled here rather
 * than by the browser: WebKit (the desktop app's WKWebView, like Safari) tabs only between text
 * fields by default, skipping buttons, and would leave the dialog.
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!container.contains(document.activeElement)) {
      const candidates = focusableElements(container)
      const preferred = container.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      const initial = (preferred && candidates.includes(preferred) ? preferred : candidates[0]) ?? container
      initial.focus()
    }

    function onKeyDown(event: KeyboardEvent) {
      // An editor inside the dialog may use Tab itself (indenting); it then prevents the default.
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const elements = focusableElements(container!)
      if (elements.length === 0) {
        event.preventDefault()
        container!.focus()
        return
      }
      event.preventDefault()
      const active = document.activeElement
      const index = elements.indexOf(active as HTMLElement)
      let next: number
      if (index !== -1) {
        next = (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length
      } else if (active instanceof Node && container!.contains(active)) {
        // Focus on something inside the dialog that is not in the list (an editable region): the
        // neighbour in document order.
        const after = elements.findIndex((element) => active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
        next = event.shiftKey
          ? (after === -1 ? elements.length : after) - 1
          : after === -1 ? 0 : after
        if (next < 0) next = elements.length - 1
      } else {
        next = event.shiftKey ? elements.length - 1 : 0
      }
      elements[next]!.focus()
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  return ref
}
