import { Suspense, useEffect, useState } from 'react'
import { sdkAvailable, type KitEditorEntry, type KitEditorProps } from './kitEditors'

/** A file a kit opens: the kit's in-page editor when its SDK is built in, its fallback otherwise. */
export function KitFilePane({ kit, ...props }: KitEditorProps & { kit: KitEditorEntry }) {
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
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  )
}
