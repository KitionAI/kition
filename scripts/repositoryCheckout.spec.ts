import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves license vector bytes in a Windows-style checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kition-checkout-'))
  const fixture = 'crates/kition-license/tests/vectors.json'
  try {
    await mkdir(dirname(join(root, fixture)), { recursive: true })
    await copyFile(resolve('.gitattributes'), join(root, '.gitattributes'))
    await copyFile(resolve(fixture), join(root, fixture))
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args,
    ], { cwd: root, stdio: 'pipe' })
    git('init', '--quiet')
    git('add', '.gitattributes', fixture)
    await rm(join(root, fixture))
    git('checkout-index', '--', fixture)
    expect(await readFile(join(root, fixture), 'utf8')).toBe(await readFile(resolve(fixture), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
