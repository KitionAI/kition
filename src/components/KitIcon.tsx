import type { ComponentType, ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/utils'

export const KIT_ICON_IDS = [
  'document', 'word', 'table', 'sheet', 'board', 'slide', 'design', 'layout',
  'vector', 'photo', 'effect', 'film', 'pdf', 'cad',
] as const

export type KitIconId = (typeof KIT_ICON_IDS)[number]

type KitIconImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>

/** A kit's app icon (docs/design.md, Kit icons). Decorative unless `alt` is given. */
export function KitIcon({ kit, alt = '', className, draggable = false, ...props }: KitIconImageProps & { kit: KitIconId }) {
  return (
    <img
      {...props}
      src={resolveBundledAssetURL(`kit-icons/${kit}.svg`)}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
      data-kit-icon={kit}
    />
  )
}

const boundKitIcons = new Map<KitIconId, ComponentType<KitIconImageProps>>()

/** A stable component for one kit, usable where an icon component is expected. */
export function kitIconComponent(kit: KitIconId): ComponentType<KitIconImageProps> {
  let component = boundKitIcons.get(kit)
  if (!component) {
    const Bound = (props: KitIconImageProps) => <KitIcon {...props} kit={kit} />
    Bound.displayName = `KitIcon(${kit})`
    component = Bound
    boundKitIcons.set(kit, component)
  }
  return component
}
