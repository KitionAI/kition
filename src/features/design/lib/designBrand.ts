/**
 * The workspace brand kit: a small JSON file under `.kition/` with the
 * colors, font, and logo that templates bind and the Brand menu applies.
 * Missing values fall back to whatever the template or layer already has.
 */
import { z } from 'zod'
import type { AgentDesignContext } from '@/types/designAgent'
import { applyDesignCommand } from './designCommands'
import { DESIGN_FONT_FAMILIES, type DesignDocument, type DesignFontFamily } from './designTypes'
import type { DesignBrandKit } from './designTemplates'

export const BRAND_KIT_PATH = '.kition/brand.json'
export const BRAND_COLOR_ROLES = ['primary', 'accent', 'text', 'surface'] as const

const color = z.string().regex(/^#[\da-f]{6}$/i)
const portablePath = z
  .string()
  .max(1024)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').includes('..'))

const schema = z
  .object({
    version: z.literal(1),
    name: z.string().max(200).optional(),
    colors: z
      .object({
        primary: color.optional(),
        accent: color.optional(),
        text: color.optional(),
        surface: color.optional(),
      })
      .strict(),
    fontFamily: z.enum(DESIGN_FONT_FAMILIES).optional(),
    logoPath: portablePath.optional(),
  })
  .strict()

export type BrandKitFile = z.infer<typeof schema>

export const EMPTY_BRAND_KIT: BrandKitFile = { version: 1, colors: {} }

export function parseBrandKit(content: string): BrandKitFile {
  return schema.parse(JSON.parse(content))
}

export const serializeBrandKit = (kit: BrandKitFile) => JSON.stringify(kit, null, 2) + '\n'

/** The bindings templates and the inspector consume. */
export function brandKitBindings(kit: BrandKitFile | null | undefined): DesignBrandKit | undefined {
  if (!kit) return undefined
  const colors: DesignBrandKit['colors'] = {}
  for (const role of BRAND_COLOR_ROLES) if (kit.colors[role]) colors[role] = kit.colors[role]
  if (!Object.keys(colors).length && !kit.fontFamily) return undefined
  return { colors, fontFamily: kit.fontFamily }
}

/** The bounded summary the Agent sees. */
export function brandKitContext(kit: BrandKitFile | null | undefined): AgentDesignContext['brand'] {
  if (!kit) return undefined
  const colors = BRAND_COLOR_ROLES.map((role) => kit.colors[role]).filter((value): value is string => Boolean(value))
  const fonts: DesignFontFamily[] = kit.fontFamily ? [kit.fontFamily] : []
  if (!colors.length && !fonts.length) return undefined
  return { colors, fonts }
}

/**
 * Applies one brand color: as the fill of the selected layers, or as the
 * artboard background when nothing is selected. Text layers take it as
 * their text color because fill is what paints their glyphs.
 */
export function applyBrandColor(doc: DesignDocument, ids: string[], value: string): DesignDocument {
  if (!ids.length) return applyDesignCommand(doc, { type: 'page', patch: { background: value } })
  return applyDesignCommand(doc, { type: 'patch', ids, patch: { fill: value } })
}

/** Applies the brand font to the selected text layers, or to every text layer. */
export function applyBrandFont(doc: DesignDocument, ids: string[], fontFamily: DesignFontFamily): DesignDocument {
  const targets = (ids.length ? ids : Object.keys(doc.nodes)).filter((id) => doc.nodes[id]?.type === 'text')
  if (!targets.length) return doc
  return applyDesignCommand(doc, { type: 'patch', ids: targets, patch: { fontFamily } })
}
