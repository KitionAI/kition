#!/usr/bin/env node
// Builds the kits `make kit-dev` and `make kit-dev-cache` run Kition with: each kit's package
// (public/kits/<kit>-ui, scripts/build-kit-ui.sh) and its headless executable
// (<repo>/target/debug/kition-<kit>, for the agent).
//
//   node scripts/kit-dev-build.mjs sheet=../kition-sheet note=../kition-note   # build every kit
//   node scripts/kit-dev-build.mjs --cache sheet=../kition-sheet ...           # only what changed
//
// Every build is recorded in target/kit-dev-cache.json: the kit's commit, a fingerprint of its
// checkout, and where its package and executable are. With --cache, a part is rebuilt only when
// its fingerprint changed or its output is gone or was replaced since. A kit's fingerprint is the
// content of its files, committed or not: committing what was built rebuilds nothing. Its package also takes the kition-sdk and kition-tessera
// checkouts its editor links, so it is rebuilt when they change. Its executable does not: the
// kit pins kition-sdk's crates by revision in its own Cargo.toml. One build runs at a time
// (target/kit-dev-build.lock): a second refuses to start while the first runs.
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORMAT = 2
// Tool caches a checkout may hold without ignoring them; they are not build inputs.
const CACHES = ['**/.vite/**', '**/__pycache__/**', '**/node_modules/**', '**/.DS_Store'].map((glob) => `:(exclude,glob)${glob}`)

function git(repo, args, env) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 1 << 30, env: env ? { ...process.env, ...env } : process.env })
  return result.status === 0 ? result.stdout : null
}

/**
 * A checkout's commit and fingerprint. The fingerprint is the Git tree of its files as they are
 * (committed or not, untracked included; ignored files and tool caches left out), so the same
 * files have the same fingerprint before and after they are committed. It is written through a
 * copy of the checkout's index, which the checkout's own index never sees. `missing` when `repo`
 * is not a Git checkout.
 */
export function checkoutFingerprint(repo) {
  if (!existsSync(repo) || git(repo, ['rev-parse', '--git-dir']) === null) return { commit: 'missing', dirty: false, tree: 'missing' }
  const commit = git(repo, ['rev-parse', '--verify', 'HEAD'])?.toString().trim() ?? 'uncommitted'
  const scratch = mkdtempSync(join(tmpdir(), 'kit-dev-index-'))
  try {
    const index = join(scratch, 'index')
    const own = resolve(repo, git(repo, ['rev-parse', '--git-path', 'index'])?.toString().trim() ?? '.git/index')
    if (existsSync(own)) copyFileSync(own, index)
    const env = { GIT_INDEX_FILE: index }
    if (git(repo, ['add', '--all', '--', '.', ...CACHES], env) === null) throw new Error(`${repo}: git add failed`)
    const tree = git(repo, ['write-tree'], env)?.toString().trim()
    if (!tree) throw new Error(`${repo}: git write-tree failed`)
    const committed = commit === 'uncommitted' ? null : git(repo, ['rev-parse', 'HEAD^{tree}'])?.toString().trim()
    return { commit, dirty: tree !== committed, tree }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    return record?.format === FORMAT && record.kits ? record : { format: FORMAT, kits: {} }
  } catch {
    return { format: FORMAT, kits: {} }
  }
}

/** Records `entry` for `kit`, over the record as it is now: other runs may record other kits. */
function recordKit(path, kit, entry) {
  const record = readRecord(path)
  record.kits[kit] = entry
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(temporary, path)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function modified(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Why a part's recorded build (`part`) no longer stands for the kit's checkout now, or null. */
function checkoutReason(part, current) {
  if (!part) return 'not built by kit-dev-cache yet'
  if (part.kitTree === current.kitTree) return null
  return part.commit === current.commit ? 'its uncommitted changes changed' : `commit ${short(part.commit)} -> ${short(current.commit)}`
}

/** Why the package must be built, or null when its recorded build still stands. */
function packageReason(part, current, packageDir) {
  const checkout = checkoutReason(part, current)
  if (checkout) return checkout
  if (part.sdkTree !== current.sdkTree) return 'kition-sdk changed'
  if (part.tesseraTree !== current.tesseraTree) return 'kition-tessera changed'
  // `make kit-fetch` or a build by hand replaces the package; only the recorded build counts.
  const marker = readJson(join(packageDir, '.kition-package.json'))
  if (!existsSync(join(packageDir, 'kit-ui.json')) || marker?.local !== true || marker.builtAt !== part.builtAt) return 'the package is missing or was replaced'
  return null
}

/** Why the executable must be built, or null when its recorded build still stands. */
function binaryReason(part, current, binary) {
  const checkout = checkoutReason(part, current)
  if (checkout) return checkout
  if (modified(binary) !== part.mtimeMs) return 'the executable is missing or was rebuilt since'
  return null
}

const short = (commit) => (/^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 9) : commit)

/**
 * Builds `kits` (`{ name, repo }`) for Kition at `root`: every part, or with `cache` only those
 * whose recorded build no longer stands. `builders.package(kit)` and `builders.binary(kit)` build
 * one part and throw when it fails. The record is written after each part, so a failed run keeps
 * what it built. Answers what each part did.
 */
export function buildKits({ root, kits, cache, recordPath = join(root, 'target', 'kit-dev-cache.json'), builders, log = console.log }) {
  const record = readRecord(recordPath)
  const fingerprints = new Map()
  const fingerprint = (repo) => {
    if (!fingerprints.has(repo)) fingerprints.set(repo, checkoutFingerprint(repo))
    return fingerprints.get(repo)
  }
  const portable = (path) => relative(root, path) || '.'
  const done = []
  for (const kit of kits) {
    const repo = resolve(root, kit.repo)
    const sdk = resolve(process.env.KITION_SDK_REPO ?? join(repo, '..', 'kition-sdk'))
    const tessera = resolve(sdk, '..', 'kition-tessera')
    const own = fingerprint(repo)
    if (own.commit === 'missing') throw new Error(`${kit.name}: ${repo} is not a Git checkout; set KIT_${kit.name.toUpperCase()}_REPO`)
    const current = { commit: own.commit, kitTree: own.tree, sdkTree: fingerprint(sdk).tree, tesseraTree: fingerprint(tessera).tree }
    const packageDir = join(root, 'public', 'kits', `${kit.name}-ui`)
    const binary = join(repo, 'target', 'debug', `kition-${kit.name}`)
    const entry = { ...record.kits[kit.name], repo: portable(repo) }
    const built = { commit: current.commit, dirty: own.dirty, kitTree: current.kitTree }
    const parts = [
      ['package', packageReason(entry.package, current, packageDir), () => {
        builders.package({ ...kit, repo })
        const marker = readJson(join(packageDir, '.kition-package.json'))
        entry.package = { path: portable(packageDir), ...built, sdkTree: current.sdkTree, tesseraTree: current.tesseraTree, builtAt: marker?.builtAt ?? null }
      }],
      ['executable', binaryReason(entry.executable, current, binary), () => {
        builders.binary({ ...kit, repo })
        entry.executable = { path: portable(binary), ...built, builtAt: new Date().toISOString(), mtimeMs: modified(binary) }
      }],
    ]
    const at = `${short(current.commit)}${own.dirty ? ' with uncommitted changes' : ''}`
    for (const [part, stale, build] of parts) {
      const reason = cache ? stale : 'full build'
      if (reason === null) {
        log(`${kit.name}: ${part} up to date at ${at}, skipped`)
        done.push({ kit: kit.name, part, built: false })
        continue
      }
      log(`${kit.name}: building the ${part} at ${at} (${reason})`)
      build()
      recordKit(recordPath, kit.name, entry)
      done.push({ kit: kit.name, part, built: true, reason })
    }
  }
  return done
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Runs `work` holding the lock file at `path`, so that two builds never write the same kit
 * packages at once. A lock whose process has ended is taken over; a live one is refused.
 */
export function withLock(path, work) {
  mkdirSync(dirname(path), { recursive: true })
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const holder = Number.parseInt(readFileSync(path, 'utf8'), 10)
      if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) {
        throw new Error(`another kit build is running (process ${holder}); wait for it to finish, or stop it first`)
      }
      rmSync(path, { force: true })
    }
  }
  try {
    return work()
  } finally {
    try {
      if (Number.parseInt(readFileSync(path, 'utf8'), 10) === process.pid) unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} failed (exit ${result.status ?? result.signal})`)
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const cache = argv.includes('--cache')
  const kits = argv.filter((arg) => arg !== '--cache').map((arg) => {
    const [name, repo] = arg.split(/=(.*)/s)
    if (!name || !repo) throw new Error(`expected <kit>=<repo>, got ${arg}`)
    return { name, repo }
  })
  if (kits.length === 0) throw new Error('usage: node scripts/kit-dev-build.mjs [--cache] <kit>=<repo> ...')
  const done = withLock(join(root, 'target', 'kit-dev-build.lock'), () =>
    buildKits({
      root,
      kits,
      cache,
      builders: {
        package: (kit) => run(join(root, 'scripts', 'build-kit-ui.sh'), [kit.name], { env: { ...process.env, KIT_REPO: kit.repo } }),
        binary: (kit) => run('cargo', ['build', '-p', `kition-${kit.name}`], { cwd: kit.repo }),
      },
    }),
  )
  const built = done.filter((part) => part.built).length
  console.log(`kits: ${built} part${built === 1 ? '' : 's'} built, ${done.length - built} up to date (record: ${relative(root, join(root, 'target', 'kit-dev-cache.json'))})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
