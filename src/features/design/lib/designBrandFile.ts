import type { DesignFontFamily } from './designTypes'

export const BRAND_KIT_PATH = '.kition/brand.json'
export const BRAND_COLOR_ROLES = ['primary', 'accent', 'text', 'surface'] as const

export type BrandKitFile = {
  version: 1
  name?: string
  colors: Partial<Record<(typeof BRAND_COLOR_ROLES)[number], string>>
  fontFamily?: DesignFontFamily
  logoPath?: string
}

export const EMPTY_BRAND_KIT: BrandKitFile = { version: 1, colors: {} }
export const serializeBrandKit = (kit: BrandKitFile) => JSON.stringify(kit, null, 2) + '\n'
