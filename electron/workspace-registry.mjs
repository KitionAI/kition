import fs from 'node:fs/promises'
import path from 'node:path'

const registryFilename = 'workspaces.json'

function nowIso() {
  return new Date().toISOString()
}

function normalizePath(input) {
  return String(input || '').trim()
}

function basename(input) {
  const trimmed = normalizePath(input).replace(/[\\/]+$/, '')
  if (!trimmed) {
    return ''
  }
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || trimmed
}

function sanitizeVaultName(name, fallback) {
  const trimmed = String(name || '').trim()
  if (trimmed) {
    return trimmed.slice(0, 200)
  }
  return fallback || 'Workspace'
}

function dedupeVaults(vaults) {
  const seen = new Set()
  const next = []
  for (const item of vaults) {
    const vaultPath = normalizePath(item?.path)
    if (!vaultPath || seen.has(vaultPath)) {
      continue
    }
    seen.add(vaultPath)
    next.push({
      path: vaultPath,
      name: sanitizeVaultName(item?.name, basename(vaultPath)),
      added_at: typeof item?.added_at === 'string' ? item.added_at : nowIso(),
      last_opened_at: typeof item?.last_opened_at === 'string' ? item.last_opened_at : '',
    })
  }
  return next
}

function sortVaults(vaults) {
  return [...vaults].sort((a, b) => {
    const lhs = a.last_opened_at || a.added_at || ''
    const rhs = b.last_opened_at || b.added_at || ''
    return rhs.localeCompare(lhs)
  })
}

export class WorkspaceRegistry {
  constructor(dataDir) {
    this.dataDir = String(dataDir || '')
    this.filePath = path.join(this.dataDir, registryFilename)
    this.state = { vaults: [], active_vault_path: '', seeded_default: false }
    this.loaded = false
    this.wasMissing = false
  }

  async load() {
    if (this.loaded) {
      return this.state
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const vaults = Array.isArray(parsed?.vaults) ? dedupeVaults(parsed.vaults) : []
      const activePath = normalizePath(parsed?.active_vault_path)
      this.state = {
        vaults,
        active_vault_path: vaults.some((item) => item.path === activePath) ? activePath : '',
        seeded_default: Boolean(parsed?.seeded_default),
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.wasMissing = true
      } else {
        console.warn('failed to load workspace registry, resetting:', error?.message || error)
      }
      this.state = { vaults: [], active_vault_path: '', seeded_default: false }
    }
    this.loaded = true
    return this.state
  }

  async save() {
    await fs.mkdir(this.dataDir, { recursive: true })
    const payload = {
      vaults: this.state.vaults,
      active_vault_path: this.state.active_vault_path,
      seeded_default: Boolean(this.state.seeded_default),
    }
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  list() {
    return {
      vaults: sortVaults(this.state.vaults),
      active_vault_path: this.state.active_vault_path,
    }
  }

  get activeVaultPath() {
    return this.state.active_vault_path
  }

  async addVault({ path: vaultPath, parent_path: parentPath, name } = {}) {
    await this.load()

    let resolvedPath = normalizePath(vaultPath)

    if (!resolvedPath) {
      const parent = normalizePath(parentPath)
      const folderName = sanitizeVaultName(name, '')
      if (!parent || !folderName) {
        throw new Error('vault path or (parent_path + name) is required')
      }
      resolvedPath = path.join(parent, folderName)
      await fs.mkdir(resolvedPath, { recursive: true })
    } else {
      const stats = await fs.stat(resolvedPath)
      if (!stats.isDirectory()) {
        throw new Error('vault path must be a directory')
      }
    }

    const existing = this.state.vaults.find((item) => item.path === resolvedPath)
    const resolvedName = sanitizeVaultName(name, basename(resolvedPath))
    if (existing) {
      existing.name = name ? resolvedName : existing.name
    } else {
      this.state.vaults.push({
        path: resolvedPath,
        name: resolvedName,
        added_at: nowIso(),
        last_opened_at: '',
      })
    }

    await this.save()
    return this.state.vaults.find((item) => item.path === resolvedPath)
  }

  async removeVault(vaultPath) {
    await this.load()
    const target = normalizePath(vaultPath)
    if (!target) {
      return this.list()
    }
    this.state.vaults = this.state.vaults.filter((item) => item.path !== target)
    if (this.state.active_vault_path === target) {
      this.state.active_vault_path = ''
    }
    await this.save()
    return this.list()
  }

  async renameVault(vaultPath, name) {
    await this.load()
    const target = normalizePath(vaultPath)
    const vault = this.state.vaults.find((item) => item.path === target)
    if (!vault) {
      throw new Error('vault not found in registry')
    }
    vault.name = sanitizeVaultName(name, vault.name)
    await this.save()
    return vault
  }

  async setActiveVault(vaultPath) {
    await this.load()
    const target = normalizePath(vaultPath)
    if (!target) {
      this.state.active_vault_path = ''
      await this.save()
      return this.list()
    }

    let vault = this.state.vaults.find((item) => item.path === target)
    if (!vault) {
      vault = await this.addVault({ path: target })
    }

    try {
      await fs.access(target)
    } catch {
      throw new Error('workspace directory does not exist')
    }

    vault.last_opened_at = nowIso()
    this.state.active_vault_path = target
    await this.save()
    return this.list()
  }

  async clearActiveVault() {
    await this.load()
    this.state.active_vault_path = ''
    await this.save()
    return this.list()
  }

  async seedDefaultVault(defaultPath) {
    await this.load()
    if (this.state.seeded_default) {
      return null
    }
    const target = normalizePath(defaultPath)
    if (!target) {
      return null
    }
    try {
      const stats = await fs.stat(target)
      if (!stats.isDirectory()) {
        return null
      }
    } catch {
      // Directory not present yet — leave seeded_default unset so the next
      // bootstrap can retry once the directory comes back.
      return null
    }
    const existing = this.state.vaults.find((item) => item.path === target)
    if (!existing) {
      this.state.vaults.push({
        path: target,
        name: sanitizeVaultName('', basename(target)),
        added_at: nowIso(),
        last_opened_at: '',
      })
    }
    this.state.seeded_default = true
    await this.save()
    return target
  }
}
