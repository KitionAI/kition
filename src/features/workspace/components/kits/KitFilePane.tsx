import { Suspense, useEffect, useState } from 'react'
import { kitSdkAvailable } from '@/features/kits/public'
import type { KitEditorEntry, KitEditorProps } from './kitEditors'

const availability = new Map<string, Promise<boolean>>()

function sdkAvailable(entry: KitEditorEntry) {
  let known = availability.get(entry.sdk.kitId)
  if (!known) {
    known = kitSdkAvailable(entry.sdk)
    availability.set(entry.sdk.kitId, known)
  }
  return known
}

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
