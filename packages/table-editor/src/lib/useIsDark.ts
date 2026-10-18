import { useEffect, useState } from 'react'

/**
 * Track whether the root `<html>` element currently carries the `dark` class.
 *
 * Many places in the UI use Tailwind's dark class strategy and therefore
 * automatically pick up `.dark` styling — but a handful of surfaces are painted
 * on `<canvas>` (the Kitable grid) or read static theme objects at render time
 * (e.g. chart libs) and need to *react* to theme changes imperatively. This
 * hook lets those surfaces re-render when the theme toggles.
 *
 * SSR-safe: defaults to `false` on the server / before mount.
 */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const sync = () => setIsDark(root.classList.contains('dark'))
    sync() // catch any class change between initial render and effect commit

    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}
