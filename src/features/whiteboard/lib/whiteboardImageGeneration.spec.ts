import { describe, expect, it } from 'vitest'

import {
  buildWhiteboardImageAgentInstruction,
  getGeneratedImageToolOutputPaths,
  isGeneratedImageArtifact,
} from './whiteboardImageGeneration'

describe('whiteboard image generation', () => {
  it('asks the Agent for artifacts without allowing an automatic board patch', () => {
    const instruction = buildWhiteboardImageAgentInstruction({
      aspectRatio: '4:3',
      boardPath: 'Boards/Launch.kiboard',
      prompt: 'Create a product hero image.',
      quality: 'high',
      requestId: 'request-1',
      resolution: '2K',
      sourceImagePaths: ['Attachments/product.png'],
      templateId: 'mixed-media-memory-card',
      textMode: 'baked_text',
      variants: 2,
    })

    expect(instruction).toContain('exactly 2 image variants')
    expect(instruction).toContain('Do not call whiteboard_propose_patch')
    expect(instruction).toContain('@{Attachments/product.png}')
  })

  it('recognizes image artifacts from kind, mime type, or extension', () => {
    expect(isGeneratedImageArtifact({ kind: 'image', path: 'Agent/output' })).toBe(true)
    expect(isGeneratedImageArtifact({ mime_type: 'image/png', path: 'Agent/output.bin' })).toBe(true)
    expect(isGeneratedImageArtifact({ path: 'Agent/output.webp' })).toBe(true)
    expect(isGeneratedImageArtifact({ kind: 'markdown', path: 'Agent/output.md' })).toBe(false)
  })

  it('reads generated workspace paths from completed image tool output', () => {
    expect(getGeneratedImageToolOutputPaths({
      output_data: {
        artifacts: [
          { path: 'Agent/generated-one.png' },
          { workspace_path: 'Agent/generated-two.webp' },
        ],
        path: 'Agent/generated-one.png',
      },
      status: 'completed',
      tool_name: 'image_generation',
    })).toEqual([
      'Agent/generated-one.png',
      'Agent/generated-two.webp',
    ])
    expect(getGeneratedImageToolOutputPaths({
      output_data: { path: 'Agent/generated.png' },
      status: 'running',
      tool_name: 'image_generation',
    })).toEqual([])
  })
})
