import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import { validateDesign } from './designSerialization'
import {
  designTemplateBrandBindings,
  designTemplateSlots,
  fillDesignTemplate,
  loadDesignTemplatePackage,
  parseDesignTemplate,
} from './designTemplates'

const dir = resolve('public/templates/design')
const readText = async (path: string) =>
  readFileSync(resolve(dir, path.replace(/^kition-bundled:\/templates\/design\//, '')), 'utf8')

describe('design template package', () => {
  it('ships a valid package whose resources match their layout files', async () => {
    const pack = await loadDesignTemplatePackage(readText)
    expectMatchesContract(pack.manifest, 'template-package')
    expect(pack.manifest.id).toBe('design-starters')
    expect(pack.templates.map(({ resource }) => resource.id)).toEqual(['editorial', 'event', 'sale', 'quote'])
    for (const { resource, template } of pack.templates) {
      expect(resource.slots).toEqual(designTemplateSlots(template))
      expect(resource.brandBindings).toEqual(designTemplateBrandBindings(template))
      expect(resource.title).toBe(template.name)
      expect(() => validateDesign(fillDesignTemplate(template))).not.toThrow()
    }
    const files = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    expect(files.sort()).toEqual(pack.templates.map(({ resource }) => `${resource.id}.json`).sort())
  })

  it('fills slots with copy and keeps template text for empty slots', () => {
    const template = parseDesignTemplate(JSON.parse(readFileSync(resolve(dir, 'event.json'), 'utf8')))
    const doc = fillDesignTemplate(template, {
      slots: { headline: 'Launch night', body: 'Doors at seven.' },
      title: 'Launch poster',
    })
    const texts = doc.pages[0].children.map((id) => doc.nodes[id]).filter((node) => node.type === 'text')
    expect(texts.map((node) => node.text)).toEqual(['CREATIVE MEETUP', 'Launch night', 'Doors at seven.'])
    expect(texts.map((node) => node.name)).toEqual(['CREATIVE MEETUP', 'Launch night', 'Doors at seven.'])
    expect(doc.title).toBe('Launch poster')
    expect(doc.pages[0]).toMatchObject({ width: 1080, height: 1440, background: '#e6e0f5' })
    expect(doc.provenance).toEqual({ templateId: 'design-template-event', templateVersion: 1 })
    expect(new Set(doc.pages[0].children).size).toBe(4)
    expect(doc.nodes[doc.pages[0].children[0]]).toMatchObject({
      type: 'ellipse',
      transform: [1, 0, 0, 1, 420, -120],
      constraints: { horizontal: 'right', vertical: 'top' },
    })
    const again = fillDesignTemplate(template)
    expect(again.pages[0].children[0]).not.toBe(doc.pages[0].children[0])
  })

  it('binds brand colors and fonts only where the template declares them', () => {
    const template = parseDesignTemplate(JSON.parse(readFileSync(resolve(dir, 'sale.json'), 'utf8')))
    const doc = fillDesignTemplate(template, {
      brand: { colors: { primary: '#0a7d5c', text: '#222222' }, fontFamily: 'Georgia' },
    })
    const [frame, label, headline, button, body] = doc.pages[0].children.map((id) => doc.nodes[id])
    expect(frame.stroke).toBe('#222222')
    expect(frame.fill).toBe('transparent')
    expect(button.fill).toBe('#0a7d5c')
    expect(label.fill).toBe('#222222')
    expect(headline.fontFamily).toBe('Georgia')
    // Bound to the surface color, which this brand kit does not define.
    expect(body.fill).toBe('#ffffff')
    // The page binds the accent color, also undefined, so the template value stays.
    expect(doc.pages[0].background).toBe('#f9e79f')
  })

  it('rejects layouts with duplicate ids or unknown fields', () => {
    const base = JSON.parse(readFileSync(resolve(dir, 'quote.json'), 'utf8'))
    expect(() => parseDesignTemplate({ ...base, layers: [...base.layers, base.layers[0]] })).toThrow(/unique/)
    expect(() => parseDesignTemplate({ ...base, layers: [{ ...base.layers[0], image: 'x.png' }] })).toThrow()
  })
})
