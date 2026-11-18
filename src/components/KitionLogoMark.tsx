import type { ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/cn'

const LOGO_SRC = resolveBundledAssetURL('logo-mark.png')
const SMALL_LOGO_SRC = resolveBundledAssetURL('favicon.png')

export interface KitionLogoMarkProps extends ImgHTMLAttributes<HTMLImageElement> {
  /** The small cut (no slots, whole pixels) for 32 px and below; docs/design.md, Brand marks. */
  small?: boolean
}

/** The Kition mark, served with the renderer in the browser and the desktop app. */
export function KitionLogoMark({
  alt = 'Kition',
  className,
  draggable = false,
  small = false,
  ...props
}: KitionLogoMarkProps) {
  return (
    <img
      {...props}
      src={small ? SMALL_LOGO_SRC : LOGO_SRC}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
    />
  )
}
