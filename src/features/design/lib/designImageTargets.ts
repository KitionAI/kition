import type { DesignAsset } from './designTypes'
const targets = new Map<string, (asset: DesignAsset) => void>()
export function registerDesignImageTarget(
  root: string,
  path: string,
  insert: (asset: DesignAsset) => void,
) {
  const key = JSON.stringify([root, path])
  targets.set(key, insert)
  return () => {
    if (targets.get(key) === insert) targets.delete(key)
  }
}
export function placeImageInDesign(
  root: string,
  path: string,
  asset: DesignAsset,
) {
  const insert = targets.get(JSON.stringify([root, path]))
  if (!insert) throw new Error('The design is no longer open')
  insert(asset)
}
