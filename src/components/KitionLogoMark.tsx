import type { ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/utils'

export const KITION_LOGO_MARK_URL = resolveBundledAssetURL('logo-mark.png')

export function KitionLogoMark({
  alt = 'Kition',
  className,
  draggable = false,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      {...props}
      src={KITION_LOGO_MARK_URL}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
    />
  )
}
