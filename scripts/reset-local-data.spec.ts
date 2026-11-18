import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/reset-local-data.sh')
const temporaryRoots: string[] = []

async function pathExists(path: string) {
  return stat(path).then(() => true, () => false)
}

async function createTestEnvironment(processOutput = '') {
  const root = await mkdtemp(join(tmpdir(), 'kition-reset-test-'))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  await mkdir(join(home, 'Library', 'Application Support', 'Kition'), { recursive: true })
  await mkdir(join(home, 'Library', 'Caches', 'Kition'), { recursive: true })
  await mkdir(join(home, 'Library', 'Logs', 'Kition'), { recursive: true })
  await writeFile(join(home, 'Library', 'Application Support', 'Kition', 'sentinel'), 'keep')
  await writeFile(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n')
  await writeFile(join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${processOutput}'\n`)
  await chmod(join(bin, 'uname'), 0o755)
  await chmod(join(bin, 'ps'), 0o755)
  return { root, home, bin }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('reset-local-data script', () => {
  it('refuses to delete data while Kition is running', async () => {
    const { home, bin } = await createTestEnvironment('4242 /Applications/Kition.app/Contents/MacOS/Kition')
    const result = spawnSync('bash', [scriptPath, '--yes'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Kition desktop client or runtime is running')
    expect(result.stderr).toContain('4242 /Applications/Kition.app/Contents/MacOS/Kition')
    expect(result.stderr).toContain('closing the window does not quit Kition')
    expect(await pathExists(join(home, 'Library', 'Application Support', 'Kition', 'sentinel'))).toBe(true)
  })

  it('removes desktop data after all Kition processes stop', async () => {
    const { home, bin } = await createTestEnvironment('51533 node /workspace/KitionAI/kition/node_modules/typescript/lib/typingsInstaller.js')
    const result = spawnSync('bash', [scriptPath, '--yes'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Reset complete.')
    expect(await pathExists(join(home, 'Library', 'Application Support', 'Kition'))).toBe(false)
    expect(await pathExists(join(home, 'Library', 'Caches', 'Kition'))).toBe(false)
    expect(await pathExists(join(home, 'Library', 'Logs', 'Kition'))).toBe(false)
  })
})
