import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validateRuntimeLock } from '../runtime-manager.mjs'

const modulePath = fileURLToPath(import.meta.url)
const moduleDir = path.dirname(modulePath)
const appDir = path.resolve(moduleDir, '..', '..')

export function validateRuntimeLockAgainstPackage(lockPayload, packagePayload) {
  const lock = validateRuntimeLock(lockPayload)
  const packageVersion = String(packagePayload?.version || '').trim()
  if (!packageVersion) {
    throw new Error('package.json is missing version')
  }
  if (lock.runtimeVersion !== packageVersion) {
    throw new Error(`runtime lock version ${lock.runtimeVersion} does not match package version ${packageVersion}`)
  }
  if (lock.releaseTag !== `v${packageVersion}`) {
    throw new Error(`runtime release tag ${lock.releaseTag} must be v${packageVersion}`)
  }
  if (lock.repository !== 'KitionAI/kition') {
    throw new Error(`runtime repository must be KitionAI/kition, got ${lock.repository}`)
  }
  return lock
}

export async function validateCheckedInRuntimeLock({
  lockPath = path.join(appDir, 'electron', 'runtime.lock.json'),
  packagePath = path.join(appDir, 'package.json'),
} = {}) {
  const [lockPayload, packagePayload] = await Promise.all([
    fs.readFile(lockPath, 'utf8').then(JSON.parse),
    fs.readFile(packagePath, 'utf8').then(JSON.parse),
  ])
  return validateRuntimeLockAgainstPackage(lockPayload, packagePayload)
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const lock = await validateCheckedInRuntimeLock()
    console.log(`[runtime-lock] version=${lock.runtimeVersion} protocol=${lock.protocolVersion} repository=${lock.repository}`)
  } catch (error) {
    console.error(`[runtime-lock] ${error.message}`)
    process.exitCode = 1
  }
}
