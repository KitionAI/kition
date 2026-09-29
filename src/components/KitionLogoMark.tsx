import { useState, type ImgHTMLAttributes } from 'react'

import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import { cn } from '@/lib/utils'

const LOGO_ASSET = 'logo-mark.png'
const LOGO_WEB_PATH = `/${LOGO_ASSET}`

/**
 * The Kition mark. Desktop builds serve it from the bundled-asset protocol;
 * when that URL cannot load (a browser preview, or a renderer that reports
 * the desktop shell without the protocol), it falls back to the web path
 * once instead of showing a broken image.
 */
export function KitionLogoMark({
  alt = 'Kition',
  className,
  draggable = false,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [src, setSrc] = useState(() => resolveBundledAssetURL(LOGO_ASSET) || LOGO_WEB_PATH)
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={cn('shrink-0', className)}
      draggable={draggable}
      onError={(event) => {
        if (src !== LOGO_WEB_PATH) setSrc(LOGO_WEB_PATH)
        onError?.(event)
      }}
    />
  )
}
