import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { KitFrame } from '@/features/kits/public'
import { embeddedAvailable, sdkAvailable, type KitEditorEntry, type KitEditorProps } from './kitEditors'

/**
 * A file a kit opens: the kit's in-page editor when its SDK is built in; otherwise the kit's
 * fallback, or `preview` (the file preview) for a kit without one.
 */
export function KitFilePane({ kit, preview, ...props }: KitEditorProps & { kit: KitEditorEntry; preview: ReactNode }) {
  const [inPage, setInPage] = useState<boolean | null>(null)
  const [own, setOwn] = useState<boolean | null>(null)

  useEffect(() => {
    let current = true
    void Promise.all([embeddedAvailable(kit), sdkAvailable(kit)]).then(([embedded, available]) => {
      if (!current) return
      setOwn(embedded)
      setInPage(available)
    })
    return () => {
      current = false
    }
  }, [kit])

  if (inPage == null || own == null) return null
  // The kit's own editor first (standard 6.1), then Kition's editor on the kit's engine.
  if (own && kit.embedded) return <KitFrame kit={kit.embedded} {...props} />
  const Editor = inPage ? kit.Editor : kit.Fallback
  if (!Editor) return preview
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  )
}
