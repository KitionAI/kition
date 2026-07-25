import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeElectronBuilderArgs,
  resolveLocalPackageBin,
} from './electron-builder-args.mjs'

describe('normalizeElectronBuilderArgs', () => {
  it('removes the pnpm argument separator', () => {
    expect(normalizeElectronBuilderArgs(['--', '--dir'])).toEqual(['--dir'])
  })

  it('preserves direct electron-builder arguments', () => {
    expect(normalizeElectronBuilderArgs(['--publish', 'never'])).toEqual([
      '--publish',
      'never',
    ])
  })

  it('does not mutate the input array', () => {
    const args = ['--', '--dir']

    normalizeElectronBuilderArgs(args)

    expect(args).toEqual(['--', '--dir'])
  })
})

describe('resolveLocalPackageBin', () => {
  it('resolves Vite and electron-builder without platform shell shims', () => {
    expect(path.basename(resolveLocalPackageBin('vite', 'vite'))).toBe('vite.js')
    expect(path.basename(resolveLocalPackageBin('electron-builder', 'electron-builder'))).toBe('cli.js')
  })
})
