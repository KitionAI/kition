const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

const publicPortalBaseURL = 'https://kition.ai'

const portalBaseURLByIdentity = {
  dev: publicPortalBaseURL,
  rc: publicPortalBaseURL,
  stable: publicPortalBaseURL,
}

export function classifyReleaseTag(tag) {
  const normalized = String(tag || '').trim()
  if (!releaseTagPattern.test(normalized)) {
    throw new Error(`unsupported release tag: ${normalized || '<empty>'}`)
  }
  const prerelease = normalized.slice(1).includes('-')
  return {
    buildIdentity: prerelease ? 'rc' : 'stable',
    prerelease,
  }
}

export function resolveBuildIdentity(env = process.env) {
  const value = String(env.KITION_BUILD_IDENTITY || '').trim().toLowerCase()
  if (!value) {
    return 'dev'
  }
  if (value === 'dev' || value === 'rc' || value === 'stable') {
    return value
  }
  throw new Error(`unsupported KITION_BUILD_IDENTITY: ${value}`)
}

export function portalBaseURLForBuildIdentity(identity) {
  const portalBaseURL = portalBaseURLByIdentity[identity]
  if (!portalBaseURL) {
    throw new Error(`unsupported build identity: ${identity}`)
  }
  return portalBaseURL
}
