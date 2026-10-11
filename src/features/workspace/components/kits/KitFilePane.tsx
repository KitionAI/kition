import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { sdkAvailable, type KitEditorEntry, type KitEditorProps } from './kitEditors'

/**
 * A file a kit opens: the kit's in-page editor when its SDK is built in; otherwise the kit's
 * fallback, or `preview` (the file preview) for a kit without one.
 */
export function KitFilePane({ kit, preview, ...props }: KitEditorProps & { kit: KitEditorEntry; preview: ReactNode }) {
  const [inPage, setInPage] = useState<boolean | null>(null)

  useEffect(() => {
    let current = true
    void sdkAvailable(kit).then((available) => {
      if (current) setInPage(available)
    })
    return () => {
      current = false
    }
  }, [kit])

  if (inPage == null) return null
  const Editor = inPage ? kit.Editor : kit.Fallback
  if (!Editor) return preview
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  )
}
