import type { ImgHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export const KITION_LOGO_MARK_URL = `${import.meta.env.BASE_URL}logo-mark.png`

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
