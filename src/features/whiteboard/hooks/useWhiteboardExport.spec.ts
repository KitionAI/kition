import { describe, expect, it, vi } from 'vitest'

import type { WhiteboardElement } from '../lib/whiteboardTypes'
import {
  getWhiteboardExportFilename,
  getWhiteboardPngRasterSize,
  resolveWhiteboardExportImageHrefs,
} from './useWhiteboardExport'

describe('useWhiteboardExport helpers', () => {
  it('embeds fetched workspace images and keeps portable paths when loading fails', async () => {
    const elements: WhiteboardElement[] = [
      {
        id: 'embedded',
        kind: 'image',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        workspacePath: 'Attachments/launch plan.png',
      },
      {
        id: 'fallback',
        kind: 'image',
        x: 220,
        y: 0,
        width: 200,
        height: 100,
        workspacePath: 'Attachments/missing.png',
      },
      {
        id: 'duplicate',
        kind: 'image',
        x: 0,
        y: 120,
        width: 200,
        height: 100,
        workspacePath: 'Attachments/launch plan.png',
      },
    ]
    const fetchImage = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
      })
      .mockRejectedValueOnce(new Error('missing'))

    const hrefs = await resolveWhiteboardExportImageHrefs(
      elements,
      fetchImage as typeof fetch,
    )

    expect(fetchImage).toHaveBeenCalledTimes(2)
    expect(fetchImage.mock.calls[0]?.[0]).toContain(
      '/workspace-files/Attachments/launch%20plan.png',
    )
    expect(hrefs.get('Attachments/launch plan.png')).toMatch(/^data:image\/png;base64,/)
    expect(hrefs.get('Attachments/missing.png')).toBe('Attachments/missing.png')

    const resolvedFallback = await resolveWhiteboardExportImageHrefs(
      [elements[1]],
      vi.fn().mockRejectedValue(new Error('missing')) as typeof fetch,
      'resolved',
    )
    expect(resolvedFallback.get('Attachments/missing.png')).toContain(
      '/workspace-files/Attachments/missing.png',
    )
  })

  it('creates a portable SVG filename', () => {
    expect(getWhiteboardExportFilename('Launch / Review')).toBe('Launch _ Review.svg')
    expect(getWhiteboardExportFilename('  ')).toBe('board.svg')
    expect(getWhiteboardExportFilename('Launch', 'png')).toBe('Launch.png')
  })

  it('bounds PNG raster dimensions by edge length and total pixels', () => {
    expect(getWhiteboardPngRasterSize(
      '<svg width="10000" height="5000"></svg>',
    )).toEqual({ width: 4096, height: 2048 })
    expect(getWhiteboardPngRasterSize(
      '<svg width="4000" height="4000"></svg>',
      { maxDimension: 10000, maxPixels: 4_000_000 },
    )).toEqual({ width: 2000, height: 2000 })
  })
})
