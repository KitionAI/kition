// Optional reference maintenance: extract a pinned commit and capture a NEW candidate file.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { cases } from './cases.mjs'

const [kitRepository, candidate] = process.argv.slice(2)
if (!kitRepository || !candidate) throw new Error('Usage: node scripts/effect-regression/capture.mjs <kit-repository> <new-candidate.json>')
const manifest = JSON.parse(await fs.readFile(path.join(kitRepository, 'kit.json'), 'utf8'))
const revision = manifest.upstream.commit
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('A full pinned reference commit is required')
const directory = path.dirname(fileURLToPath(import.meta.url))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-effect-reference-'))
try {
  const source = path.join(temporary, 'source')
  const probe = path.join(temporary, 'probe')
  await fs.mkdir(source)
  await fs.mkdir(path.join(probe, 'src'), { recursive: true })
  const archive = execFileSync('git', ['-C', path.resolve(kitRepository), 'archive', revision], { maxBuffer: 128 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive })
  const dependencies = await Promise.all(['engine', 'expr'].map(async alias => {
    const crateDirectory = path.join(source, 'crates', alias)
    const crateManifest = await fs.readFile(path.join(crateDirectory, 'Cargo.toml'), 'utf8')
    const packageName = /^name\s*=\s*"([^"]+)"/m.exec(crateManifest)?.[1]
    if (!packageName) throw new Error(`Cannot find the reference ${alias} package`)
    return `${alias} = { package = ${JSON.stringify(packageName)}, path = ${JSON.stringify(crateDirectory)} }`
  }))
  await fs.writeFile(path.join(probe, 'Cargo.toml'), [
    '[package]', 'name = "kition-effect-reference-probe"', 'version = "0.0.0"', 'edition = "2024"',
    '[dependencies]', ...dependencies,
    'serde_json = "1"', '',
  ].join('\n'))
  await fs.copyFile(path.join(source, 'Cargo.lock'), path.join(probe, 'Cargo.lock'))
  const adapterSource = await fs.readFile(path.join(directory, 'reference.rs'))
  await fs.writeFile(path.join(probe, 'src', 'main.rs'), adapterSource)
  const input = JSON.stringify(cases)
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['run', '--quiet', '--manifest-path', path.join(probe, 'Cargo.toml')], {
      // Reuse compiled reference dependencies between deliberate captures. Normal tests need none.
      env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'kition-effect-reference-target') },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`Reference capture exited ${code}`)))
    child.stdin.on('error', reject)
    child.stdin.end(input)
  })
  const results = JSON.parse(stdout)
  for (const result of results) for (const snapshot of result.snapshots) {
    const rgba = Buffer.from(snapshot.rgba)
    snapshot.rgbaSha256 = createHash('sha256').update(rgba).digest('hex')
    snapshot.rgbaGzip = gzipSync(rgba, { level: 9 }).toString('base64')
    delete snapshot.rgba
  }
  const baseline = {
    schema: 1, reference: {
      version: manifest.upstream.version, commit: revision, adapter: 'command-session-expressions-cpu-rgba8',
      compiler: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
      cargoLockSha256: createHash('sha256').update(await fs.readFile(path.join(probe, 'Cargo.lock'))).digest('hex'),
    },
    casesSha256: createHash('sha256').update(input).digest('hex'),
    adapterSha256: createHash('sha256').update(adapterSource).digest('hex'),
    capturedAt: new Date().toISOString(), results,
  }
  await fs.writeFile(candidate, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' })
  console.log(`Captured ${results.length} cases to a new candidate; compare and review before adopting it.`)
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
