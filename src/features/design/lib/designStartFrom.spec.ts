import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDesign } from './designSerialization'
import { designFromImage, designFromRecord, recordSlots } from './designStartFrom'
import { parseDesignTemplate } from './designTemplates'
import type { DesignAsset } from './designTypes'

const asset: DesignAsset = { id: 'a1', path: 'Agent/images/1/launch.png', mimeType: 'image/png', width: 1024, height: 1536 }
const template = parseDesignTemplate(JSON.parse(readFileSync(resolve('public/templates/design/sale.json'), 'utf8')))

describe('start a design from', () => {
  it('an image, keeping the headline editable', () => {
    const doc = designFromImage(asset, { title: 'Launch', headline: 'Launch night' })
    expect(doc.pages[0]).toMatchObject({ width: 1024, height: 1536 })
    const [image, headline] = doc.pages[0].children.map((id) => doc.nodes[id])
    expect(image).toMatchObject({ type: 'image', width: 1024, height: 1536 })
    expect(headline).toMatchObject({ type: 'text', text: 'Launch night' })
    expect(doc.provenance).toEqual({ imagePath: asset.path })
    expect(designFromImage(asset, { title: 'Plain' }).pages[0].children).toHaveLength(1)
    expect(() => validateDesign(doc)).not.toThrow()
  })

  it('a record, matching fields to slots by name', () => {
    expect(
      recordSlots({ Title: 'Autumn drop', Description: ['Warm', 'Bold'], Status: { name: 'Live' }, Price: 12 }),
    ).toEqual({ headline: 'Autumn drop', body: 'Warm, Bold', label: 'Live' })
    const doc = designFromRecord(template, { Product: 'Autumn drop', tagline: 'Warm layers' }, { brand: { colors: { primary: '#0a7d5c' } } })
    const texts = doc.pages[0].children.map((id) => doc.nodes[id]).filter((node) => node.type === 'text')
    expect(texts.map((node) => node.text)).toEqual(['THE NEW SEASON', 'Autumn drop', 'Warm layers'])
    expect(doc.title).toBe('Autumn drop')
    const button = doc.pages[0].children.map((id) => doc.nodes[id]).find((node) => node.name === 'Button')
    expect(button?.fill).toBe('#0a7d5c')
    expect(designFromRecord(template, {}).title).toBe('Promotion')
  })
})
