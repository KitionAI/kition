import type { Bounds, DesignAsset, DesignNode } from './designTypes'

/** Fill: keep the layer's box and crop the image to cover it, centered. */
export function imageFillCrop(asset: Pick<DesignAsset, 'width' | 'height'>, node: Pick<DesignNode, 'width' | 'height'>): Bounds {
  const scale = Math.max(node.width / asset.width, node.height / asset.height)
  const width = Math.min(asset.width, node.width / scale)
  const height = Math.min(asset.height, node.height / scale)
  return {
    x: Math.round((asset.width - width) / 2),
    y: Math.round((asset.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * Fit: show the whole image and shrink the layer's box to the image's
 * aspect ratio inside its current bounds, keeping the box centered.
 */
export function imageFitPatch(
  asset: Pick<DesignAsset, 'width' | 'height'>,
  node: Pick<DesignNode, 'width' | 'height' | 'transform'>,
): Pick<DesignNode, 'width' | 'height' | 'transform' | 'crop'> {
  const scale = Math.min(node.width / asset.width, node.height / asset.height)
  const width = asset.width * scale
  const height = asset.height * scale
  const [a, b, c, d, e, f] = node.transform
  return {
    width,
    height,
    transform: [a, b, c, d, e + (node.width - width) / 2, f + (node.height - height) / 2],
    crop: { x: 0, y: 0, width: asset.width, height: asset.height },
  }
}
