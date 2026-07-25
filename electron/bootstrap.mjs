import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const bootstrapBuildChannelCommunity = 'community'
const bootstrapStateUnavailable = 'unavailable'
const bootstrapCodeCommunityBuild = 'BOOTSTRAP_COMMUNITY_BUILD'
const installationFileName = 'installation.json'

function newInstallationID() {
  return `ins_${crypto.randomBytes(12).toString('hex')}`
}

function communityBootstrapStatus(installationId) {
  return {
    official_build: false,
    build_channel: bootstrapBuildChannelCommunity,
    available: false,
    state: bootstrapStateUnavailable,
    installation_id: installationId,
    diagnostics: {
      code: bootstrapCodeCommunityBuild,
      title: 'This build does not include the official bootstrap check',
      message: 'Community builds do not auto-initialize a default AI provider. Open Settings to configure a provider manually.',
      detail: 'Official builds embed the proprietary bootstrap module at packaging time; this repository uses the public community placeholder by default.',
      support_id: '',
      retryable: false,
      next_action: 'manual_provider_setup',
    },
  }
}

// The installation id is an anonymous device identifier; encrypting it via
// safeStorage triggered the macOS Keychain unlock dialog on first launch
// without any security benefit. Persist it as plaintext alongside other
// non-secret app state.
export class CommunityBootstrap {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, installationFileName)
  }

  async ensureInstallationId() {
    const existing = await this.readInstallationId()
    if (existing) return existing

    const value = newInstallationID()
    await this.writeInstallationId(value)
    return value
  }

  async readInstallationId() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const id = typeof parsed?.installation_id === 'string' ? parsed.installation_id.trim() : ''
      return id
    } catch {
      return ''
    }
  }

  async writeInstallationId(value) {
    await fs.mkdir(this.dataDir, { recursive: true })
    const payload = JSON.stringify({ installation_id: value }, null, 2) + '\n'
    await fs.writeFile(this.filePath, payload, 'utf8')
  }

  async initialize() {
    const installationId = await this.ensureInstallationId()
    return {
      installation_id: installationId,
      status: communityBootstrapStatus(installationId),
    }
  }

  async createAttestation() {
    const installationId = await this.ensureInstallationId()
    return {
      status: communityBootstrapStatus(installationId),
    }
  }

  async status() {
    const installationId = await this.ensureInstallationId()
    return communityBootstrapStatus(installationId)
  }
}
