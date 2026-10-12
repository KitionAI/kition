import { describe, expect, it } from 'vitest'
import { resolveLentPath } from './lentFiles'

describe('lent file paths', () => {
  it('resolves against the document folder and the workspace root', () => {
    expect(resolveLentPath('films/trailer', 'media/a.mp4')).toBe('films/trailer/media/a.mp4')
    expect(resolveLentPath('films/trailer', '../shared/b.mov')).toBe('films/shared/b.mov')
    expect(resolveLentPath('films/trailer', '/clips/c.mp4')).toBe('clips/c.mp4')
    expect(resolveLentPath('', './d.wav')).toBe('d.wav')
  })

  it('never leaves the workspace', () => {
    expect(() => resolveLentPath('films', '../../etc/passwd')).toThrow()
    expect(() => resolveLentPath('', '..')).toThrow()
    expect(() => resolveLentPath('films', '')).toThrow()
  })
})
