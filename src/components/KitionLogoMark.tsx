import type { ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/utils'

const LOGO_SRC = resolveBundledAssetURL('logo-mark.png')

/** The Kition mark, served with the renderer in the browser and the desktop app. */
export function KitionLogoMark({
  alt = 'Kition',
  className,
  draggable = false,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      {...props}
      src={LOGO_SRC}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
    />
  )
}
