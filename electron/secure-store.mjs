import fs from 'node:fs/promises'
import path from 'node:path'

const plaintextPrefix = 'plain-v1:'
const encryptedPrefix = 'enc-v1:'

function sanitizeKey(key) {
  return String(key || '').replaceAll('/', '_').replaceAll('\\', '_').replaceAll('..', '_')
}

// Desktop secrets live as plaintext files inside the app's userData directory.
// We deliberately don't touch macOS Keychain / safeStorage
// — every re-signed build (dev rebuild, version bump) was popping a "wants to
// use Kition Safe Storage" prompt because the keychain ACL was bound to the
// previous binary's signature. The data is already on the user's disk under
// their account's file permissions; the keychain layer added prompts without
// adding security.
export class SecureStore {
  constructor(env) {
    this.env = env
    this.fallbackDir = path.join(env.data_dir, 'secrets')
  }

  async initialize() {}

  async set(key, value) {
    await fs.mkdir(this.fallbackDir, { recursive: true })
    await fs.writeFile(this.getPath(key), `${plaintextPrefix}${String(value)}`, 'utf8')
  }

  async get(key) {
    try {
      const data = await fs.readFile(this.getPath(key), 'utf8')
      if (data.startsWith(plaintextPrefix)) {
        return data.slice(plaintextPrefix.length)
      }
      // Legacy ciphertext from the old safeStorage-backed implementation —
      // unreadable without keychain access, treated as missing so we never
      // trigger a keychain prompt to decrypt it.
      if (data.startsWith(encryptedPrefix)) {
        return ''
      }
      // Pre-prefix legacy files were already plaintext JSON.
      return data
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  async delete(key) {
    try {
      await fs.rm(this.getPath(key))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }

  getPath(key) {
    return path.join(this.fallbackDir, `${sanitizeKey(key)}.secret`)
  }
}
