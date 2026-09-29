import type { DesignDocument } from '../lib/designTypes'
import { DesignArtworkLayer } from './DesignArtworkLayer'
export function DesignArtwork({
  document: doc,
  images,
  prefix = 'design',
  editingId,
  onImageError,
}: {
  document: DesignDocument
  images: Record<string, string>
  prefix?: string
  editingId?: string | null
  onImageError?: (id: string) => void
}) {
  function render(id: string) {
    const n = doc.nodes[id]
    if (!n || !n.visible) return null
    return (
      <DesignArtworkLayer
        key={id}
        node={n}
        asset={n.assetId ? doc.assets[n.assetId] : undefined}
        url={n.assetId ? images[n.assetId] : undefined}
        prefix={prefix}
        editingId={editingId === id ? id : null}
        onImageError={onImageError}
      >
        {n.type === 'group' ? n.children.map(render) : undefined}
      </DesignArtworkLayer>
    )
  }
  const page = doc.pages[0]
  return (
    <>
      <rect width={page.width} height={page.height} fill={page.background} />
      {page.children.map(render)}
    </>
  )
}
