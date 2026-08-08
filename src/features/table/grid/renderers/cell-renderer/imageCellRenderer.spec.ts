import { describe, expect, it, vi } from 'vitest'

import { getCoverCrop, getImageWidth, imageCellRenderer } from './imageCellRenderer'
import { CellType } from './interface'

describe('imageCellRenderer image framing', () => {
  it('uses the configured field aspect ratio for every thumbnail width', () => {
    const portraitImage = { width: 512, height: 1024 } as HTMLImageElement

    expect(getImageWidth({ id: 'image', url: '/image.png' }, portraitImage, 90)).toBe(45)
    expect(
      getImageWidth({ id: 'image', url: '/image.png' }, portraitImage, 90, 4 / 3),
    ).toBe(120)
  })

  it('center-crops portrait and landscape images without stretching them', () => {
    expect(getCoverCrop(512, 1024, 120, 90)).toEqual({
      sx: 0,
      sy: 320,
      sw: 512,
      sh: 384,
    })
    expect(getCoverCrop(1600, 900, 120, 90)).toEqual({
      sx: 200,
      sy: 0,
      sw: 1200,
      sh: 900,
    })
  })

  it('opens the attachment picker when the active-cell add icon is clicked', () => {
    const onAdd = vi.fn()
    const callback = vi.fn()

    imageCellRenderer.onClick?.(
      {
        type: CellType.Image,
        data: [],
        displayData: [],
        readonly: false,
        onAdd,
      },
      {
        width: 200,
        height: 32,
        theme: { iconSizeSM: 20 },
        hoverCellPosition: [10, 16],
        activeCellBound: null,
        isActive: true,
      } as never,
      callback,
    )

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
  })
})
