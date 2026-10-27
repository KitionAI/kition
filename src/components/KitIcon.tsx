import type { ComponentType, ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/cn'

export const KIT_ICON_IDS = [
  'note', 'doc', 'table', 'sheet', 'board', 'slide', 'design',
  'vector', 'photo', 'effect', 'film', 'pdf', 'cad', 'html', 'cube', 'fig',
] as const

export type KitIconId = (typeof KIT_ICON_IDS)[number]

type KitIconImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>

/**
 * A kit's app icon (docs/design.md, Kit icons). Decorative unless `alt` is given.
 * Pass `small` at 32 px and below for the bold cut that stays legible.
 */
export function KitIcon({
  kit,
  small = false,
  alt = '',
  className,
  draggable = false,
  ...props
}: KitIconImageProps & { kit: KitIconId; small?: boolean }) {
  return (
    <img
      {...props}
      src={resolveBundledAssetURL(`kit-icons/${kit}${small ? '-small' : ''}.svg`)}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
      data-kit-icon={kit}
    />
  )
}

const boundKitIcons = new Map<string, ComponentType<KitIconImageProps>>()

/** A stable component for one kit, usable where an icon component is expected. */
export function kitIconComponent(kit: KitIconId, { small = false }: { small?: boolean } = {}): ComponentType<KitIconImageProps> {
  const key = `${kit}${small ? ':small' : ''}`
  let component = boundKitIcons.get(key)
  if (!component) {
    const Bound = (props: KitIconImageProps) => <KitIcon {...props} kit={kit} small={small} />
    Bound.displayName = `KitIcon(${key})`
    component = Bound
    boundKitIcons.set(key, component)
  }
  return component
}
