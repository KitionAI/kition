import { describe, expect, it } from 'vitest'
import { DESIGN_FONT_FACES, designFontFaceCSS, isBundledDesignFont } from './designFonts'
import { DESIGN_FONT_FAMILIES } from './designTypes'

describe('bundled design fonts', () => {
  it('covers every non-system family with latin and latin-ext faces', () => {
    const bundled = DESIGN_FONT_FAMILIES.filter(isBundledDesignFont)
    expect(bundled).toEqual(['Inter', 'Lora', 'JetBrains Mono', 'Bricolage Grotesque'])
    for (const family of bundled) {
      const faces = DESIGN_FONT_FACES.filter((face) => face.family === family)
      expect(faces.length).toBeGreaterThanOrEqual(2)
      expect(new Set(faces.map((face) => face.unicodeRange)).size).toBe(faces.length)
    }
    expect(isBundledDesignFont('Arial')).toBe(false)
  })

  it('embeds only the faces of the used families as data URLs', async () => {
    const loaded: string[] = []
    const css = await designFontFaceCSS(['Lora', 'Arial', 'Lora'], async (url) => {
      loaded.push(url)
      return `data:font/woff2;base64,${url.length}`
    })
    expect(loaded).toEqual(DESIGN_FONT_FACES.filter((face) => face.family === 'Lora').map((face) => face.url))
    expect(css.match(/@font-face/g)).toHaveLength(3)
    expect(css).toContain('font-family:"Lora";font-weight:100 900;unicode-range:U+0000-00FF')
    expect(css).toContain('src:url(data:font/woff2;base64,')
    expect(css).not.toContain('Inter')
    expect(await designFontFaceCSS(['Georgia'], async () => 'never')).toBe('')
  })
})
