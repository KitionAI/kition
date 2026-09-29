import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDesignSVG, designPdfHtml } from './designExport'
import {
  DEFAULT_EXPORT_PRESETS,
  exportBackground,
  loadDesignExportPresets,
  saveDesignExportPresets,
} from './designExportPresets'
import { createDesign, createDesignNode, type DesignDocument } from './designTypes'

function fixture(): DesignDocument {
  const doc = createDesign('Export', 400, 300)
  doc.nodes.h = createDesignNode('text', { id: 'h', text: 'Hello', fontFamily: 'Inter', fontSize: 40, width: 300, height: 60 })
  doc.nodes.r = createDesignNode('rectangle', { id: 'r', width: 100, height: 50, fill: '#5645d4' })
  doc.nodes.hidden = createDesignNode('text', { id: 'hidden', text: 'Nope', fontFamily: 'Lora', visible: false })
  doc.pages[0].children.push('r', 'h', 'hidden')
  return doc
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('design export', () => {
  it('builds valid standalone SVG with only the used bundled fonts embedded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    const { svg, width, height } = await buildDesignSVG(fixture(), 'root', { scale: 2 })
    expect({ width, height }).toEqual({ width: 800, height: 600 })
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.documentElement.tagName).toBe('svg')
    expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 400 300')
    expect(parsed.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    const style = parsed.querySelector('style')?.textContent ?? ''
    expect(style).toContain('font-family:"Inter"')
    expect(style).toContain('data:font/woff2;base64,AQID')
    expect(style).not.toContain('Lora')
    expect(svg).toContain('Hello')
    expect(svg).not.toContain('Nope')
  })

  it('applies a background override and enforces the limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })))
    const { svg } = await buildDesignSVG(fixture(), 'root', { background: 'transparent' })
    expect(svg).not.toContain('#ffffff')
    await expect(buildDesignSVG(fixture(), 'root', { scale: 100 })).rejects.toMatchObject({ code: 'exportLimit' })
    await expect(buildDesignSVG(fixture(), 'root', { background: 'transparent', format: 'jpeg' })).rejects.toMatchObject({
      code: 'jpegBackground',
    })
  })

  it('wraps the SVG for the desktop PDF printer at the artboard size', () => {
    const html = designPdfHtml('<svg xmlns="http://www.w3.org/2000/svg"/>', 400, 300)
    expect(html).toContain('width:400px;height:300px')
    expect(html).toContain('src="data:image/svg+xml;base64,')
    expect(html).toContain('background:transparent')
  })

  it('remembers export presets and validates stored values', () => {
    expect(loadDesignExportPresets()).toEqual(DEFAULT_EXPORT_PRESETS)
    saveDesignExportPresets({ scale: 2, background: 'transparent' })
    expect(loadDesignExportPresets()).toEqual({ scale: 2, background: 'transparent' })
    localStorage.setItem('kition.design.export.v1', JSON.stringify({ scale: 9, background: 'neon' }))
    expect(loadDesignExportPresets()).toEqual(DEFAULT_EXPORT_PRESETS)
    localStorage.setItem('kition.design.export.v1', '{not json')
    expect(loadDesignExportPresets()).toEqual(DEFAULT_EXPORT_PRESETS)
    expect(exportBackground({ scale: 1, background: 'white' })).toBe('#ffffff')
    expect(exportBackground({ scale: 1, background: 'transparent' })).toBe('transparent')
    expect(exportBackground(DEFAULT_EXPORT_PRESETS)).toBeUndefined()
  })
})
