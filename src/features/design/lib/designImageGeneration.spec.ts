import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import {
  artboardAspectRatio,
  buildDesignImageAgentInstruction,
  placeGeneratedImageInDesign,
} from './designImageGeneration'
import { validateDesign } from './designSerialization'
import { createDesign, type DesignAsset } from './designTypes'

const asset: DesignAsset = {
  id: 'generated',
  path: 'Agent/images/901/generated-launch.png',
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
}

describe('design image generation', () => {
  it('picks the studio ratio closest to the artboard', () => {
    expect(artboardAspectRatio(1080, 1440)).toBe('3:4')
    expect(artboardAspectRatio(1080, 1920)).toBe('9:16')
    expect(artboardAspectRatio(1920, 1080)).toBe('16:9')
    expect(artboardAspectRatio(1080, 1080)).toBe('1:1')
    expect(artboardAspectRatio(1200, 800)).toBe('3:2')
  })

  it('tells the agent to generate artifacts without patching the design', () => {
    const instruction = buildDesignImageAgentInstruction({
      aspectRatio: '3:4',
      prompt: 'A calm launch city',
      quality: 'medium',
      requestId: 'r1',
      resolution: '1K',
      sourceImagePaths: ['Agent/images/ref.png'],
      targetPath: 'posters/launch.kidesign',
      templateId: 'surreal-city-poster',
      textMode: 'editable_overlay',
      variants: 2,
    })
    expect(instruction).toContain('Generate exactly 2 image variants using the image_generation tool')
    expect(instruction).toContain('Do not call design_propose_patch')
    expect(instruction).toContain('Reference image 1: @{Agent/images/ref.png}')
    expect(instruction).toContain('A calm launch city')
  })

  it('covers the artboard with the image and centers an editable headline above it', () => {
    const doc = createDesign('Poster', 1080, 1440)
    const placed = placeGeneratedImageInDesign(doc, asset, { exactText: ' LAUNCH NIGHT ', textMode: 'editable_overlay' })
    const [imageId, headlineId] = placed.document.pages[0].children
    expect(placed.nodeIds).toEqual([imageId, headlineId])
    const image = placed.document.nodes[imageId]
    expect(image).toMatchObject({ type: 'image', assetId: 'generated', width: 1440, height: 1440 })
    expect(image.transform[4]).toBe(-180)
    expect(image.constraints).toEqual({ horizontal: 'scale', vertical: 'scale' })
    const headline = placed.document.nodes[headlineId]
    expect(headline).toMatchObject({
      type: 'text',
      text: 'LAUNCH NIGHT',
      textAlign: 'center',
      fontFamily: 'Bricolage Grotesque',
      constraints: { horizontal: 'center', vertical: 'center' },
    })
    expect(headline.transform[4] + headline.width / 2).toBe(540)
    expect(placed.document.assets.generated).toEqual(asset)
    expect(() => validateDesign(placed.document)).not.toThrow()
  })

  it('adds only the image for baked or absent text and keeps it under existing layers', () => {
    const doc = createDesign('Poster', 1080, 1440)
    const withText = placeGeneratedImageInDesign(doc, asset, { exactText: 'Baked', textMode: 'baked_text' })
    expect(withText.document.pages[0].children).toHaveLength(1)
    const again = placeGeneratedImageInDesign(withText.document, { ...asset, id: 'second' }, { exactText: '', textMode: 'editable_overlay' })
    expect(again.document.pages[0].children[0]).toBe(again.nodeIds[0])
    expect(again.document.pages[0].children).toHaveLength(2)
  })

  it('describes a design target the contract accepts', () => {
    expectMatchesContract(
      { type: 'image.target.design', design_path: 'posters/launch.kidesign', artboard: { width: 1080, height: 1440 } },
      'agent-image-generation',
      'designTarget',
    )
  })
})
