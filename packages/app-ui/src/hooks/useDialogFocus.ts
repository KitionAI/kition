import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Tabbable descendants in document order, skipping anything hidden from assistive technology. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[aria-hidden="true"]'),
  )
}

/**
 * Focus management for a dialog that mounts while open. On mount, focus
 * moves to the first tabbable descendant (or the container, which must
 * have `tabIndex={-1}`); Tab and Shift+Tab wrap inside; on unmount focus
 * returns to the element that had it before the dialog opened.
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!container.contains(document.activeElement)) {
      const initial = focusableElements(container)[0] ?? container
      initial.focus()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const elements = focusableElements(container!)
      if (elements.length === 0) {
        event.preventDefault()
        container!.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !container!.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !container!.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  return ref
}
