import { describe, expect, it } from 'vitest'
import {
  alignReleaseVersion,
  assertReleaseGitHubLogin,
  desktopAssetNames,
  parseReleaseArguments,
  parseStatusPaths,
  REQUIRED_RELEASE_GITHUB_LOGIN,
  selectWorkflowRun,
  validateRef,
  validateVersion,
  workflowRunOutcome,
} from './release-github.mjs'

describe('release-github CLI', () => {
  it('parses the release version and workflow options', () => {
    expect(parseReleaseArguments([
      '0.1.3',
      '--yes',
      '--resume',
      '--timeout-minutes',
      '120',
    ])).toEqual({
      version: '0.1.3',
      sourceRef: 'main',
      timeoutMinutes: 120,
      yes: true,
      dryRun: false,
      resume: true,
      help: false,
    })
  })

  it('rejects official releases that are not published as the maintainer GitHub account', () => {
    expect(REQUIRED_RELEASE_GITHUB_LOGIN).toBe('allentatakai')
    expect(assertReleaseGitHubLogin('allentatakai')).toBe('allentatakai')
    expect(() => assertReleaseGitHubLogin('wrong-publisher')).toThrow(
      'Official releases must be published as allentatakai, got wrong-publisher. Run: gh auth switch --user allentatakai',
    )
    expect(() => assertReleaseGitHubLogin('')).toThrow('got <empty>')
  })

  it('rejects unsafe versions and refs', () => {
    expect(() => validateVersion('v0.1.3')).toThrow('Invalid release version')
    expect(() => validateRef('../main')).toThrow('Invalid ref')
    expect(() => validateRef('-main')).toThrow('Invalid ref')
  })

  it('aligns the package version', () => {
    expect(alignReleaseVersion({ name: 'kition', version: '0.1.2' }, '0.1.3')).toEqual({
      name: 'kition',
      version: '0.1.3',
    })
  })

  it('builds the required desktop asset list', () => {
    expect(desktopAssetNames('0.1.3')).toContain('Kition-0.1.3-windows-x64-setup.exe')
    expect(desktopAssetNames('0.1.3')).toContain('Kition-0.1.3-macos-arm64.dmg')
    expect(desktopAssetNames('0.1.3')).toContain('Kition-0.1.3-macos-x64.app.tar.gz.sig')
    expect(desktopAssetNames('0.1.3')).toContain('latest.json')
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

  it('classifies workflow completion without treating pending runs as failures', () => {
    expect(workflowRunOutcome({ status: 'queued', conclusion: '' })).toBe('pending')
    expect(workflowRunOutcome({ status: 'in_progress', conclusion: '' })).toBe('pending')
    expect(workflowRunOutcome({ status: 'completed', conclusion: 'success' })).toBe('success')
    expect(workflowRunOutcome({ status: 'completed', conclusion: 'failure' })).toBe('failure')
  })

  it('parses porcelain status without dropping the first path character', () => {
    expect(parseStatusPaths(
      ' M src-tauri/tauri.conf.json\0 M package.json\0R  docs/new.md\0docs/old.md\0',
    )).toEqual([
      'src-tauri/tauri.conf.json',
      'package.json',
      'docs/new.md',
      'docs/old.md',
    ])
  })
})
