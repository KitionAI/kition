import { useEffect, useState } from 'react'
import { subscribeWorkspaceDocumentExternalChanges } from '@/services/desktop'
import { designAssetDataURL, decodeDesignImage } from '../lib/designAssets'
import type { DesignDocument } from '../lib/designTypes'
export function useDesignImages(root: string, doc: DesignDocument) {
  const manifest = JSON.stringify(
    Array.from(
      new Set(
        Object.values(doc.nodes)
          .filter((n) => n.type === 'image')
          .map((n) => n.assetId!),
      ),
    ).map((id) => [id, doc.assets[id].path]),
  )
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{
    images: Record<string, string>
    missing: string[]
  }>({ images: {}, missing: [] })
  useEffect(() => {
    const paths = new Set(
      (JSON.parse(manifest) as [string, string][]).map(([, path]) => path),
    )
    return subscribeWorkspaceDocumentExternalChanges((change) => {
      if (paths.has(change.path)) setVersion((value) => value + 1)
    })
  }, [manifest])
  useEffect(() => {
    let canceled = false
    void (async () => {
      const images: Record<string, string> = {},
        missing: string[] = []
      await Promise.all(
        (JSON.parse(manifest) as [string, string][]).map(async ([id, path]) => {
          try {
            const dataURL = await designAssetDataURL(root, path)
            await decodeDesignImage(dataURL)
            images[id] = dataURL
          } catch {
            missing.push(path)
          }
        }),
      )
      if (!canceled) setState({ images, missing })
    })()
    return () => {
      canceled = true
    }
  }, [root, manifest, version])
  return state
}
