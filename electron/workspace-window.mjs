import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

export const WORKSPACE_WINDOW_FLAG = '--kition-workspace-window'
export const WORKSPACE_WINDOW_PATH_FLAG = '--kition-workspace-path='
const workspaceWindowProfilesDirectory = 'workspace-window-profiles'

export function encodeWorkspaceWindowPath(workspacePath) {
  return Buffer.from(String(workspacePath || ''), 'utf8').toString('base64url')
}

export function decodeWorkspaceWindowPath(encodedPath) {
  const value = String(encodedPath || '').trim()
  if (!value) {
    return ''
  }
  try {
    return Buffer.from(value, 'base64url').toString('utf8').trim()
  } catch {
    return ''
  }
}

export function readWorkspaceWindowRequest(argv = process.argv) {
  if (!Array.isArray(argv) || !argv.includes(WORKSPACE_WINDOW_FLAG)) {
    return null
  }
  const encodedPath = String(
    argv.find((argument) => String(argument).startsWith(WORKSPACE_WINDOW_PATH_FLAG)) || '',
  ).slice(WORKSPACE_WINDOW_PATH_FLAG.length)
  const workspacePath = decodeWorkspaceWindowPath(encodedPath)
  return workspacePath ? { workspacePath } : null
}

export function workspaceWindowProfilePath(sharedDataDir, workspacePath) {
  const workspaceID = createHash('sha256')
    .update(path.resolve(String(workspacePath || '')))
    .digest('hex')
    .slice(0, 16)
  return path.join(sharedDataDir, workspaceWindowProfilesDirectory, workspaceID)
}

export function buildWorkspaceWindowLaunch({
  execPath,
  appEntry = '',
  profilePath,
  workspacePath,
}) {
  const args = [`--user-data-dir=${profilePath}`]
  if (appEntry) {
    args.push(appEntry)
  }
  args.push(
    WORKSPACE_WINDOW_FLAG,
    `${WORKSPACE_WINDOW_PATH_FLAG}${encodeWorkspaceWindowPath(workspacePath)}`,
  )
  return {
    command: execPath,
    args,
  }
}

export async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

export async function openWorkspaceWindowProcess({
  workspacePath,
  sharedDataDir,
  execPath = process.execPath,
  appEntry = process.defaultApp ? process.argv[1] : '',
  environment = process.env,
  reservePort = reserveLoopbackPort,
  spawnProcess = spawn,
}) {
  const requestedWorkspacePath = String(workspacePath || '').trim()
  const requestedSharedDataDir = String(sharedDataDir || '').trim()
  if (!requestedWorkspacePath || !requestedSharedDataDir) {
    throw new Error('workspace path and shared data directory are required')
  }
  const normalizedWorkspacePath = path.resolve(requestedWorkspacePath)
  const profilePath = workspaceWindowProfilePath(requestedSharedDataDir, normalizedWorkspacePath)
  await fs.mkdir(profilePath, { recursive: true })
  const backendPort = await reservePort()
  if (!Number.isInteger(backendPort) || backendPort <= 0) {
    throw new Error('failed to reserve a backend port for the workspace window')
  }

  const launch = buildWorkspaceWindowLaunch({
    execPath,
    appEntry,
    profilePath,
    workspacePath: normalizedWorkspacePath,
  })
  const child = spawnProcess(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    env: {
      ...environment,
      KITION_DESKTOP_API_PORT: String(backendPort),
      KITION_DESKTOP_SHARED_DATA_DIR: requestedSharedDataDir,
    },
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()

  return {
    backendPort,
    profilePath,
  }
}
