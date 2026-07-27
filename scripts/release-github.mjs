#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PUBLIC_REPOSITORY = 'KitionAI/kition'
const RUNTIME_REPOSITORY = 'KitionAI/kition-dev'
const RUNTIME_BUILD_REPOSITORY = 'KitionAI/kition-dev'
const RUNTIME_SOURCE_REPOSITORY = 'KitionAI/kition-runtime'
const PUBLISH_WORKFLOW = 'publish-release.yml'
const RUNTIME_WORKFLOW = 'build-release-assets.yml'
const CI_WORKFLOW = 'ci.yml'
const DEFAULT_SOURCE_REF = 'main'
const DEFAULT_RUNTIME_REF = 'main'
const DEFAULT_TIMEOUT_MINUTES = 90
const POLL_INTERVAL_MS = 15_000

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)[0-9A-Za-z._/-]+$/

export function releaseUsage() {
  return [
    'Usage: pnpm release:github <version> [options]',
    '',
    'Options:',
    '  --source-ref <ref>       Public client branch to release (default: main)',
    '  --runtime-ref <ref>      Private runtime ref to build (default: main)',
    '  --timeout-minutes <n>    Overall workflow timeout (default: 90)',
    '  --resume                 Resume an aligned release without repeating local checks',
    '  --force-prepare          Rebuild runtime assets while Releases are still drafts',
    '  --dry-run                Validate context without changing release state',
    '  --yes                    Skip the interactive version confirmation',
    '  --help                   Show this help',
  ].join('\n')
}

export function parseReleaseArguments(argv) {
  const options = {
    version: '',
    sourceRef: DEFAULT_SOURCE_REF,
    runtimeRef: DEFAULT_RUNTIME_REF,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    yes: false,
    dryRun: false,
    resume: false,
    forcePrepare: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('-') && !options.version) {
      options.version = argument
      continue
    }
    if (argument === '--yes') {
      options.yes = true
      continue
    }
    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (argument === '--force-prepare') {
      options.forcePrepare = true
      continue
    }
    if (argument === '--resume') {
      options.resume = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--source-ref') {
      options.sourceRef = argv[++index] || ''
      continue
    }
    if (argument === '--runtime-ref') {
      options.runtimeRef = argv[++index] || ''
      continue
    }
    if (argument === '--timeout-minutes') {
      options.timeoutMinutes = Number(argv[++index])
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (options.help) return options
  validateVersion(options.version)
  validateRef(options.sourceRef, 'source ref')
  validateRef(options.runtimeRef, 'runtime ref')
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes < 10) {
    throw new Error('--timeout-minutes must be at least 10')
  }
  return options
}

export function validateVersion(version) {
  if (!VERSION_PATTERN.test(String(version || ''))) {
    throw new Error(`Invalid release version: ${version || '<empty>'}`)
  }
  return version
}

export function validateRef(ref, label = 'ref') {
  if (!REF_PATTERN.test(String(ref || ''))) {
    throw new Error(`Invalid ${label}: ${ref || '<empty>'}`)
  }
  return ref
}

export function alignReleaseVersion(packagePayload, runtimeLock, version) {
  if (!packagePayload || typeof packagePayload !== 'object') {
    throw new Error('package.json is not a JSON object')
  }
  if (!runtimeLock || typeof runtimeLock !== 'object') {
    throw new Error('electron/runtime.lock.json is not a JSON object')
  }
  if (runtimeLock.repository !== RUNTIME_REPOSITORY) {
    throw new Error(`Runtime repository must be ${RUNTIME_REPOSITORY}`)
  }
  if (!Number.isInteger(runtimeLock.protocolVersion) || runtimeLock.protocolVersion < 1) {
    throw new Error('Runtime protocol version must be a positive integer')
  }
  return {
    packagePayload: { ...packagePayload, version },
    runtimeLock: {
      ...runtimeLock,
      runtimeVersion: version,
      releaseTag: `v${version}`,
    },
  }
}

export function runtimeAssetNames(version) {
  return [
    'runtime-manifest.json',
    'runtime-SHA256SUMS.txt',
    'runtime-provenance.json',
    `kition-runtime-${version}-darwin-arm64.tar.gz`,
    `kition-runtime-${version}-darwin-x64.tar.gz`,
    `kition-runtime-${version}-windows-x64.zip`,
    `kition-runtime-${version}-linux-x64.tar.gz`,
  ]
}

export function runtimeArtifactNames(version) {
  return [
    ...runtimeAssetNames(version),
    'runtime-sbom-darwin-arm64.spdx.json',
    'runtime-sbom-darwin-x64.spdx.json',
    'runtime-sbom-windows-x64.spdx.json',
    'runtime-sbom-linux-x64.spdx.json',
  ]
}

export function desktopAssetNames(version) {
  return [
    `Kition-${version}-macos-arm64.dmg`,
    `Kition-${version}-macos-arm64.dmg.blockmap`,
    `Kition-${version}-macos-x64.dmg`,
    `Kition-${version}-macos-x64.dmg.blockmap`,
    `Kition-${version}-windows-x64-setup.exe`,
    `Kition-${version}-windows-x64-setup.exe.blockmap`,
    `Kition-${version}-linux-x86_64.AppImage`,
    'latest-mac.yml',
    'latest.yml',
    'latest-linux.yml',
  ]
}

export function selectWorkflowRun(runs, { headSha, dispatchedAfter }) {
  const threshold = new Date(dispatchedAfter).getTime() - 5_000
  return [...runs]
    .filter((run) => !headSha || run.headSha === headSha)
    .filter((run) => new Date(run.createdAt).getTime() >= threshold)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0] || null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true })
  return String(result.stdout || '').trim()
}

function captureJson(command, args, options = {}) {
  const output = capture(command, args, options)
  return output ? JSON.parse(output) : null
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

function getRepositoryRoot() {
  return capture('git', ['rev-parse', '--show-toplevel'])
}

function getStatusPaths(rootDir) {
  const output = capture('git', ['status', '--porcelain=v1'], { cwd: rootDir })
  if (!output) return []
  return output.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
}

function assertAllowedChanges(rootDir, allowedPaths) {
  const unexpected = getStatusPaths(rootDir).filter((filePath) => !allowedPaths.includes(filePath))
  if (unexpected.length) {
    throw new Error(`Release requires a clean worktree. Unexpected changes: ${unexpected.join(', ')}`)
  }
}

function assetNames(release) {
  return new Set((release?.assets || []).map((asset) => asset.name))
}

function missingAssets(release, expected) {
  const names = assetNames(release)
  return expected.filter((name) => !names.has(name))
}

function viewRelease(repository, tag) {
  const result = run('gh', [
    'release', 'view', tag,
    '--repo', repository,
    '--json', 'tagName,isDraft,isPrerelease,url,publishedAt,assets',
  ], { capture: true, allowFailure: true })
  if (result.status !== 0) return null
  return JSON.parse(String(result.stdout || '{}'))
}

function getHeadSha(rootDir) {
  return capture('git', ['rev-parse', 'HEAD'], { cwd: rootDir })
}

function assertAlignedReleaseFiles(rootDir, version) {
  const packagePayload = readJson(path.join(rootDir, 'package.json'))
  const runtimeLock = readJson(path.join(rootDir, 'electron', 'runtime.lock.json'))
  alignReleaseVersion(packagePayload, runtimeLock, version)
  if (
    packagePayload.version !== version ||
    runtimeLock.runtimeVersion !== version ||
    runtimeLock.releaseTag !== `v${version}`
  ) {
    throw new Error(`--resume requires package.json and electron/runtime.lock.json to already match ${version}`)
  }
  return runtimeLock
}

function getTagCommit(rootDir, tag) {
  const result = run('git', ['rev-parse', `${tag}^{commit}`], {
    cwd: rootDir,
    capture: true,
    allowFailure: true,
  })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function assertTagVersion(rootDir, tag, version) {
  const packagePayload = JSON.parse(capture('git', ['show', `${tag}:package.json`], { cwd: rootDir }))
  const runtimeLock = JSON.parse(capture('git', ['show', `${tag}:electron/runtime.lock.json`], { cwd: rootDir }))
  alignReleaseVersion(packagePayload, runtimeLock, version)
  if (
    packagePayload.version !== version ||
    runtimeLock.runtimeVersion !== version ||
    runtimeLock.releaseTag !== tag
  ) {
    throw new Error(`Tag ${tag} does not contain the aligned ${version} release files`)
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function confirmRelease(options) {
  if (options.yes || options.dryRun) return
  if (!process.stdin.isTTY) {
    throw new Error('Use --yes for non-interactive release execution')
  }
  const releaseKind = options.version.includes('-') ? 'prerelease' : 'stable release'
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type v${options.version} to publish the GitHub ${releaseKind}: `)
    if (answer.trim() !== `v${options.version}`) {
      throw new Error('Release confirmation did not match')
    }
  } finally {
    prompt.close()
  }
}

async function waitForWorkflowRun({ repository, workflow, headSha, dispatchedAfter, timeoutAt }) {
  while (Date.now() < timeoutAt) {
    const runs = captureJson('gh', [
      'run', 'list',
      '--repo', repository,
      '--workflow', workflow,
      '--limit', '20',
      '--json', 'databaseId,status,conclusion,createdAt,url,headSha',
    ]) || []
    const runInfo = selectWorkflowRun(runs, { headSha, dispatchedAfter })
    if (runInfo) return runInfo
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for ${workflow} to start`)
}

async function watchWorkflow({ repository = PUBLIC_REPOSITORY, workflow, headSha, dispatchedAfter, timeoutAt }) {
  const runInfo = await waitForWorkflowRun({ repository, workflow, headSha, dispatchedAfter, timeoutAt })
  console.log(`[release] watching ${workflow}: ${runInfo.url}`)
  run('gh', ['run', 'watch', String(runInfo.databaseId), '--repo', repository, '--exit-status'])
  return runInfo
}

async function waitForCi(headSha, timeoutAt) {
  const dispatchedAfter = '1970-01-01T00:00:00.000Z'
  await watchWorkflow({ workflow: CI_WORKFLOW, headSha, dispatchedAfter, timeoutAt })
}

function ensurePublicDraft(version, releaseCommit) {
  const tag = `v${version}`
  let tagCommit = getTagCommit(getRepositoryRoot(), tag)
  if (!tagCommit) {
    run('gh', [
      'api', '--method', 'POST', `repos/${PUBLIC_REPOSITORY}/git/refs`,
      '-f', `ref=refs/tags/${tag}`,
      '-f', `sha=${releaseCommit}`,
    ])
    run('git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
    tagCommit = getTagCommit(getRepositoryRoot(), tag)
  }
  if (tagCommit !== releaseCommit) {
    throw new Error(`Tag ${tag} points to ${tagCommit} instead of ${releaseCommit}`)
  }

  const release = viewRelease(PUBLIC_REPOSITORY, tag)
  if (release) {
    if (!release.isDraft) return verifyPublishedRelease(version)
    return release
  }
  run('gh', [
    'release', 'create', tag,
    '--repo', PUBLIC_REPOSITORY,
    '--draft',
    '--target', releaseCommit,
    '--title', `Kition ${version}`,
    '--generate-notes',
  ])
  return viewRelease(PUBLIC_REPOSITORY, tag)
}

function ensureRuntimeDraft(version) {
  const tag = `v${version}`
  const release = viewRelease(RUNTIME_REPOSITORY, tag)
  if (release) return release
  run('gh', [
    'release', 'create', tag,
    '--repo', RUNTIME_REPOSITORY,
    '--draft',
    '--title', `Kition Runtime ${version}`,
    '--notes', `Developer runtime binaries for Kition ${version}. Runtime source is not included.`,
  ])
  return viewRelease(RUNTIME_REPOSITORY, tag)
}

function repositoryRefSha(repository, ref) {
  return capture('gh', [
    'api', '--method', 'GET', `repos/${repository}/commits`,
    '-f', `sha=${ref}`,
    '-f', 'per_page=1',
    '--jq', '.[0].sha',
  ])
}

function dispatchRuntime(options) {
  run('gh', [
    'workflow', 'run', RUNTIME_WORKFLOW,
    '--repo', RUNTIME_BUILD_REPOSITORY,
    '--ref', DEFAULT_SOURCE_REF,
    '-f', `version=${options.version}`,
    '-f', `release_tag=v${options.version}`,
    '-f', `protocol_version=${options.protocolVersion}`,
    '-f', `runtime_ref=${options.runtimeRef}`,
    '-f', `public_repository=${PUBLIC_REPOSITORY}`,
  ])
}

function releaseAssetFiles(directory, version, requireArtifacts) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Runtime artifact must contain files at its root only')
  }
  const names = entries.map((entry) => entry.name).sort()
  const allowed = new Set(runtimeArtifactNames(version))
  const unexpected = names.filter((name) => !allowed.has(name))
  if (unexpected.length) {
    throw new Error(`Runtime artifact contains unexpected files: ${unexpected.join(', ')}`)
  }
  const required = requireArtifacts ? runtimeArtifactNames(version) : runtimeAssetNames(version)
  const missing = required.filter((name) => !names.includes(name))
  if (missing.length) {
    throw new Error(`Runtime artifact is missing files: ${missing.join(', ')}`)
  }
  return names.map((name) => path.join(directory, name))
}

function uploadReleaseFiles(repository, tag, files) {
  const release = viewRelease(repository, tag)
  if (!release?.isDraft) {
    throw new Error(`Release ${tag} in ${repository} must be a draft before uploading assets`)
  }
  run('gh', ['release', 'upload', tag, '--repo', repository, '--clobber', ...files])
}

function publishRuntimeRelease(version) {
  run('gh', [
    'release', 'edit', `v${version}`,
    '--repo', RUNTIME_REPOSITORY,
    '--draft=false',
    `--prerelease=${version.includes('-')}`,
  ])
}

function downloadReleaseAssets(repository, version, directory) {
  const args = [
    'release', 'download', `v${version}`,
    '--repo', repository,
    '--dir', directory,
  ]
  for (const name of runtimeAssetNames(version)) args.push('--pattern', name)
  run('gh', args)
  return releaseAssetFiles(directory, version, false)
}

async function buildAndStageRuntime(options, timeoutAt) {
  const tag = `v${options.version}`
  ensureRuntimeDraft(options.version)
  const dispatchedAfter = new Date().toISOString()
  const runtimeCommit = repositoryRefSha(RUNTIME_SOURCE_REPOSITORY, options.runtimeRef)
  const headSha = repositoryRefSha(RUNTIME_BUILD_REPOSITORY, DEFAULT_SOURCE_REF)
  console.log(`[release] runtime source ${options.runtimeRef} resolves to ${runtimeCommit.slice(0, 12)}`)
  console.log(`[release] dispatching ${RUNTIME_BUILD_REPOSITORY}/${RUNTIME_WORKFLOW}`)
  dispatchRuntime(options)
  const runInfo = await watchWorkflow({
    repository: RUNTIME_BUILD_REPOSITORY,
    workflow: RUNTIME_WORKFLOW,
    headSha,
    dispatchedAfter,
    timeoutAt,
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-runtime-release-'))
  try {
    run('gh', [
      'run', 'download', String(runInfo.databaseId),
      '--repo', RUNTIME_BUILD_REPOSITORY,
      '--name', `runtime-release-assets-${options.version}`,
      '--dir', directory,
    ])
    const files = releaseAssetFiles(directory, options.version, true)
    uploadReleaseFiles(RUNTIME_REPOSITORY, tag, files)
    uploadReleaseFiles(PUBLIC_REPOSITORY, tag, files)
    publishRuntimeRelease(options.version)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function copyRuntimeAssets(sourceRepository, targetRepository, version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-runtime-copy-'))
  try {
    const files = downloadReleaseAssets(sourceRepository, version, directory)
    uploadReleaseFiles(targetRepository, `v${version}`, files)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function waitForRuntimeAssets(version, timeoutAt) {
  const tag = `v${version}`
  const expectedRuntimeAssets = runtimeAssetNames(version)
  let lastReport = 0
  while (Date.now() < timeoutAt) {
    const runtimeRelease = viewRelease(RUNTIME_REPOSITORY, tag)
    const installerDraft = viewRelease(PUBLIC_REPOSITORY, tag)
    const runtimeMissing = missingAssets(runtimeRelease, expectedRuntimeAssets)
    const installerMissing = missingAssets(installerDraft, expectedRuntimeAssets)
    if (
      runtimeRelease && runtimeRelease.isDraft === false && runtimeMissing.length === 0 &&
      installerDraft && installerDraft.isDraft === true && installerMissing.length === 0
    ) {
      console.log(`[release] verified published runtime and staged installer assets for ${tag}`)
      return
    }
    if (Date.now() - lastReport >= 60_000) {
      console.log(`[release] waiting for runtime assets (${runtimeMissing.length} runtime, ${installerMissing.length} staged missing)`)
      lastReport = Date.now()
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for runtime assets for ${tag}. Re-run with --force-prepare after checking the runtime build workflow.`)
}

function dispatchPublish(options) {
  run('gh', [
    'workflow', 'run', PUBLISH_WORKFLOW,
    '--repo', PUBLIC_REPOSITORY,
    '--ref', options.sourceRef,
    '-f', `version=${options.version}`,
  ])
}

function verifyPublishedRelease(version) {
  const release = viewRelease(PUBLIC_REPOSITORY, `v${version}`)
  const expectedPrerelease = version.includes('-')
  if (!release || release.isDraft || release.isPrerelease !== expectedPrerelease) {
    throw new Error(`GitHub Release v${version} has the wrong publication state`)
  }
  const missing = missingAssets(release, desktopAssetNames(version))
  if (missing.length) {
    throw new Error(`GitHub Release v${version} is missing assets: ${missing.join(', ')}`)
  }
  return release
}

async function executeRelease(options) {
  const rootDir = getRepositoryRoot()
  process.chdir(rootDir)

  run('gh', ['auth', 'status'])
  const repositoryName = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (repositoryName !== PUBLIC_REPOSITORY) {
    throw new Error(`Expected ${PUBLIC_REPOSITORY}, got ${repositoryName}`)
  }
  const currentBranch = capture('git', ['branch', '--show-current'], { cwd: rootDir })
  if (currentBranch !== options.sourceRef) {
    throw new Error(`Release source ref ${options.sourceRef} must be the current branch`)
  }

  const alreadyPublished = viewRelease(PUBLIC_REPOSITORY, `v${options.version}`)
  if (alreadyPublished && !alreadyPublished.isDraft) {
    const release = verifyPublishedRelease(options.version)
    console.log(`[release] already published: ${release.url}`)
    return release
  }

  assertAllowedChanges(rootDir, [])
  if (options.dryRun) {
    if (options.resume) {
      assertAlignedReleaseFiles(rootDir, options.version)
    } else {
      alignReleaseVersion(
        readJson(path.join(rootDir, 'package.json')),
        readJson(path.join(rootDir, 'electron', 'runtime.lock.json')),
        options.version,
      )
    }
    console.log(`[release] target=v${options.version} source=${options.sourceRef} runtime=${options.runtimeRef}`)
    console.log('[release] dry run complete; no files or remote state changed')
    return null
  }

  run('git', ['fetch', 'origin', options.sourceRef, '--tags'], { cwd: rootDir })
  const divergence = capture('git', [
    'rev-list', '--left-right', '--count', `HEAD...origin/${options.sourceRef}`,
  ], { cwd: rootDir }).split(/\s+/).map(Number)
  if (divergence[0] > 0 && divergence[1] > 0) {
    throw new Error(`Local ${options.sourceRef} has diverged from origin/${options.sourceRef}`)
  }
  if (divergence[0] === 0 && divergence[1] > 0) {
    run('git', ['pull', '--ff-only', 'origin', options.sourceRef], { cwd: rootDir })
  }

  await confirmRelease(options)
  console.log(`[release] target=v${options.version} source=${options.sourceRef} runtime=${options.runtimeRef}`)

  const packagePath = path.join(rootDir, 'package.json')
  const runtimeLockPath = path.join(rootDir, 'electron', 'runtime.lock.json')
  const currentPackage = readJson(packagePath)
  const currentRuntimeLock = readJson(runtimeLockPath)
  if (options.resume) assertAlignedReleaseFiles(rootDir, options.version)
  const aligned = alignReleaseVersion(currentPackage, currentRuntimeLock, options.version)
  const needsVersionUpdate =
    currentPackage.version !== options.version ||
    currentRuntimeLock.runtimeVersion !== options.version ||
    currentRuntimeLock.releaseTag !== `v${options.version}`

  if (options.resume && needsVersionUpdate) {
    throw new Error(`--resume requires release files to already match ${options.version}`)
  }
  if (!options.resume && needsVersionUpdate) {
    writeJson(packagePath, aligned.packagePayload)
    writeJson(runtimeLockPath, aligned.runtimeLock)
  }
  assertAllowedChanges(rootDir, ['package.json', 'electron/runtime.lock.json'])

  if (!options.resume) {
    console.log('[release] running repository checks')
    run('pnpm', ['check'], { cwd: rootDir })
    run('pnpm', ['test:table:e2e'], { cwd: rootDir })
    assertAllowedChanges(rootDir, ['package.json', 'electron/runtime.lock.json'])

    if (getStatusPaths(rootDir).length) {
      run('git', ['add', 'package.json', 'electron/runtime.lock.json'], { cwd: rootDir })
      run('git', ['commit', '-m', `Release Kition ${options.version}`], { cwd: rootDir })
    }
    run('git', ['push', 'origin', options.sourceRef], { cwd: rootDir })
  } else {
    console.log('[release] resume mode: reusing aligned files, pushed source, and completed CI')
  }
  const headSha = getHeadSha(rootDir)
  const timeoutAt = Date.now() + options.timeoutMinutes * 60_000

  if (!options.resume) {
    console.log(`[release] waiting for CI on ${headSha.slice(0, 12)}`)
    await waitForCi(headSha, timeoutAt)
  }

  const tag = `v${options.version}`
  run('git', ['fetch', 'origin', '--tags'], { cwd: rootDir })
  let releaseCommit = headSha
  if (options.resume) {
    releaseCommit = getTagCommit(rootDir, tag)
    if (!releaseCommit) throw new Error(`--resume requires the immutable tag ${tag}`)
    assertTagVersion(rootDir, tag, options.version)
  }
  ensurePublicDraft(options.version, releaseCommit)

  const publicDraft = viewRelease(PUBLIC_REPOSITORY, tag)
  const runtimeRelease = viewRelease(RUNTIME_REPOSITORY, tag)
  const stagedMissing = missingAssets(publicDraft, runtimeAssetNames(options.version))
  const runtimeMissing = missingAssets(runtimeRelease, runtimeAssetNames(options.version))

  if (runtimeRelease && !runtimeRelease.isDraft && runtimeMissing.length === 0) {
    if (stagedMissing.length) {
      console.log(`[release] staging published runtime assets on the installer draft`)
      copyRuntimeAssets(RUNTIME_REPOSITORY, PUBLIC_REPOSITORY, options.version)
    } else {
      console.log(`[release] reusing published runtime assets for ${tag}`)
    }
  } else if (publicDraft?.isDraft && stagedMissing.length === 0 && !options.forcePrepare) {
    const draft = ensureRuntimeDraft(options.version)
    if (!draft.isDraft) {
      throw new Error(`Runtime Release ${tag} is published but incomplete`)
    }
    console.log(`[release] publishing runtime assets already staged on the installer draft`)
    copyRuntimeAssets(PUBLIC_REPOSITORY, RUNTIME_REPOSITORY, options.version)
    publishRuntimeRelease(options.version)
  } else {
    if (runtimeRelease && !runtimeRelease.isDraft) {
      throw new Error(`Runtime Release ${tag} is published but incomplete and cannot be replaced`)
    }
    await buildAndStageRuntime({
      ...options,
      protocolVersion: currentRuntimeLock.protocolVersion,
    }, timeoutAt)
  }

  await waitForRuntimeAssets(options.version, timeoutAt)

  const dispatchedAfter = new Date().toISOString()
  console.log(`[release] dispatching ${PUBLISH_WORKFLOW}`)
  dispatchPublish(options)
  await watchWorkflow({ workflow: PUBLISH_WORKFLOW, headSha, dispatchedAfter, timeoutAt })

  const release = verifyPublishedRelease(options.version)
  console.log(`[release] published ${release.url}`)
  return release
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseReleaseArguments(argv)
  if (options.help) {
    console.log(releaseUsage())
    return null
  }
  return executeRelease(options)
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`[release] ${error?.message || error}`)
    process.exitCode = 1
  })
}
