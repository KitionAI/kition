import { describe, expect, it } from 'vitest'
import {
  alignReleaseVersion,
  desktopAssetNames,
  parseReleaseArguments,
  parseStatusPaths,
  runtimeArtifactNames,
  runtimeAssetNames,
  selectWorkflowRun,
  validateRef,
  validateVersion,
} from './release-github.mjs'

describe('release-github CLI', () => {
  it('parses the release version and workflow options', () => {
    expect(parseReleaseArguments([
      '0.1.3',
      '--yes',
      '--resume',
      '--runtime-ref',
      'release/runtime-0.1.3',
      '--timeout-minutes',
      '120',
    ])).toEqual({
      version: '0.1.3',
      sourceRef: 'main',
      runtimeRef: 'release/runtime-0.1.3',
      timeoutMinutes: 120,
      yes: true,
      dryRun: false,
      resume: true,
      forcePrepare: false,
      help: false,
    })
  })

  it('rejects unsafe versions and refs', () => {
    expect(() => validateVersion('v0.1.3')).toThrow('Invalid release version')
    expect(() => validateRef('../main')).toThrow('Invalid ref')
    expect(() => validateRef('-main')).toThrow('Invalid ref')
  })

  it('aligns the package and runtime lock versions', () => {
    expect(alignReleaseVersion(
      { name: 'kition', version: '0.1.2' },
      {
        schemaVersion: 1,
        runtimeVersion: '0.1.2',
        protocolVersion: 1,
        releaseTag: 'v0.1.2',
        repository: 'KitionAI/kition-dev',
      },
      '0.1.3',
    )).toEqual({
      packagePayload: { name: 'kition', version: '0.1.3' },
      runtimeLock: {
        schemaVersion: 1,
        runtimeVersion: '0.1.3',
        protocolVersion: 1,
        releaseTag: 'v0.1.3',
        repository: 'KitionAI/kition-dev',
      },
    })
  })

  it('builds the required runtime and desktop asset lists', () => {
    expect(runtimeAssetNames('0.1.3')).toContain('kition-runtime-0.1.3-darwin-arm64.tar.gz')
    expect(runtimeArtifactNames('0.1.3')).toContain('runtime-sbom-linux-x64.spdx.json')
    expect(desktopAssetNames('0.1.3')).toContain('Kition-0.1.3-windows-x64-setup.exe')
    expect(desktopAssetNames('0.1.3')).toContain('latest-mac.yml')
  })

  it('selects the newest matching workflow run after dispatch', () => {
    const run = selectWorkflowRun([
      {
        databaseId: 1,
        headSha: 'abc',
        createdAt: '2026-07-27T10:00:00.000Z',
      },
      {
        databaseId: 2,
        headSha: 'abc',
        createdAt: '2026-07-27T10:01:00.000Z',
      },
      {
        databaseId: 3,
        headSha: 'other',
        createdAt: '2026-07-27T10:02:00.000Z',
      },
    ], {
      headSha: 'abc',
      dispatchedAfter: '2026-07-27T10:00:30.000Z',
    })

    expect(run?.databaseId).toBe(2)
  })

  it('parses porcelain status without dropping the first path character', () => {
    expect(parseStatusPaths(
      ' M electron/runtime.lock.json\0 M package.json\0R  docs/new.md\0docs/old.md\0',
    )).toEqual([
      'electron/runtime.lock.json',
      'package.json',
      'docs/new.md',
      'docs/old.md',
    ])
  })
})
