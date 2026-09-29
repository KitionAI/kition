/**
 * The bundled open-license font set (SIL OFL 1.1, notices in docs/legal).
 * Faces register through the FontFace API on first use so the editor and
 * the export measure the same glyphs, and exports embed the used faces as
 * data URLs because a standalone SVG cannot load external files.
 */
import bricolageLatin from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2?url'
import bricolageLatinExt from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2?url'
import interCyrillic from '@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2?url'
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interLatinExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url'
import monoCyrillic from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2?url'
import monoLatin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url'
import monoLatinExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url'
import loraCyrillic from '@fontsource-variable/lora/files/lora-cyrillic-wght-normal.woff2?url'
import loraLatin from '@fontsource-variable/lora/files/lora-latin-wght-normal.woff2?url'
import loraLatinExt from '@fontsource-variable/lora/files/lora-latin-ext-wght-normal.woff2?url'
import type { DesignFontFamily } from './designTypes'

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'

export type DesignFontFace = { family: DesignFontFamily; url: string; unicodeRange: string }

export const DESIGN_FONT_FACES: readonly DesignFontFace[] = [
  { family: 'Inter', url: interLatin, unicodeRange: LATIN },
  { family: 'Inter', url: interLatinExt, unicodeRange: LATIN_EXT },
  { family: 'Inter', url: interCyrillic, unicodeRange: CYRILLIC },
  { family: 'Lora', url: loraLatin, unicodeRange: LATIN },
  { family: 'Lora', url: loraLatinExt, unicodeRange: LATIN_EXT },
  { family: 'Lora', url: loraCyrillic, unicodeRange: CYRILLIC },
  { family: 'JetBrains Mono', url: monoLatin, unicodeRange: LATIN },
  { family: 'JetBrains Mono', url: monoLatinExt, unicodeRange: LATIN_EXT },
  { family: 'JetBrains Mono', url: monoCyrillic, unicodeRange: CYRILLIC },
  { family: 'Bricolage Grotesque', url: bricolageLatin, unicodeRange: LATIN },
  { family: 'Bricolage Grotesque', url: bricolageLatinExt, unicodeRange: LATIN_EXT },
]

export const isBundledDesignFont = (family: string) => DESIGN_FONT_FACES.some((face) => face.family === family)

let registered: Promise<void> | null = null
/** Registers every bundled face once; resolves when they are loaded. */
export function loadDesignFonts(): Promise<void> {
  if (registered) return registered
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return (registered = Promise.resolve())
  registered = Promise.all(
    DESIGN_FONT_FACES.map(async (face) => {
      const font = new FontFace(face.family, `url(${face.url}) format('woff2-variations')`, {
        weight: '100 900',
        unicodeRange: face.unicodeRange,
      })
      document.fonts.add(font)
      await font.load().catch(() => undefined)
    }),
  ).then(() => undefined)
  return registered
}

function designFontFaceRule(face: DesignFontFace, src: string): string {
  return `@font-face{font-family:"${face.family}";font-weight:100 900;unicode-range:${face.unicodeRange};src:url(${src}) format("woff2-variations")}`
}

async function fetchFontDataURL(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Font ${url} failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return `data:font/woff2;base64,${btoa(binary)}`
}

/** CSS that embeds the bundled faces of `families`; empty for system fonts. */
export async function designFontFaceCSS(
  families: Iterable<string>,
  load: (url: string) => Promise<string> = fetchFontDataURL,
): Promise<string> {
  const wanted = new Set(families)
  const faces = DESIGN_FONT_FACES.filter((face) => wanted.has(face.family))
  const rules = await Promise.all(faces.map(async (face) => designFontFaceRule(face, await load(face.url))))
  return rules.join('')
}
