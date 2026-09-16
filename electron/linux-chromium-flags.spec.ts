import { describe, expect, it, vi } from 'vitest'
import { applyLinuxChromiumFlags } from './linux-chromium-flags.mjs'

function createCommandLine() {
  return {
    appendSwitch: vi.fn(),
  }
}

describe('linux chromium launch flags', () => {
  it('disables the GPU sandbox on Linux so AppImage can load host Mesa libraries', () => {
    const commandLine = createCommandLine()

    expect(applyLinuxChromiumFlags(commandLine, 'linux')).toEqual(['disable-gpu-sandbox'])
    expect(commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu-sandbox')
  })

  it('does not change Chromium flags on macOS or Windows', () => {
    const mac = createCommandLine()
    const windows = createCommandLine()

    expect(applyLinuxChromiumFlags(mac, 'darwin')).toEqual([])
    expect(applyLinuxChromiumFlags(windows, 'win32')).toEqual([])
    expect(mac.appendSwitch).not.toHaveBeenCalled()
    expect(windows.appendSwitch).not.toHaveBeenCalled()
  })
})
