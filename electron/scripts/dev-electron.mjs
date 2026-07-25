import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { shouldTerminateDevProcess } from './dev-processes.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(moduleDir, '..', '..')
const execFileAsync = promisify(execFile)

function resolveServerURL(server) {
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') {
    throw new Error('unable to resolve Vite dev server address')
  }
  return `http://127.0.0.1:${address.port}`
}

async function listProcesses() {
  if (process.platform === 'win32') {
    return []
  }

  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/)
      if (!match) {
        return null
      }
      return {
        pid: Number(match[1]),
        command: match[2],
      }
    })
    .filter(Boolean)
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminateStaleProcesses() {
  const processes = await listProcesses()
  const stale = processes.filter((entry) => shouldTerminateDevProcess(entry, {
    currentPid: process.pid,
    uiDir,
  }))
  if (!stale.length) {
    return
  }

  for (const entry of stale) {
    try {
      process.kill(entry.pid, 'SIGTERM')
    } catch {
      // The process may already be gone.
    }
  }

  await delay(800)

  const remaining = (await listProcesses()).filter((entry) =>
    stale.some((candidate) => candidate.pid === entry.pid),
  )

  for (const entry of remaining) {
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      // The process may already be gone.
    }
  }
}

let viteServer = null
let electron = null
let cleanedUp = false

async function cleanup(exitCode = 0) {
  if (cleanedUp) {
    return
  }
  cleanedUp = true

  if (electron && !electron.killed) {
    electron.kill('SIGTERM')
  }

  if (viteServer) {
    await viteServer.close()
  }

  process.exit(exitCode)
}

try {
  await terminateStaleProcesses()

  viteServer = await createServer({
    root: uiDir,
    clearScreen: false,
    logLevel: 'info',
    server: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: false,
    },
  })

  await viteServer.listen()
  viteServer.printUrls()

  const devServerURL = resolveServerURL(viteServer)
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  electron = spawn(packageManager, ['exec', 'electron', '.'], {
    cwd: uiDir,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      KITION_ELECTRON_DEV_SERVER_URL: devServerURL,
      KITION_DESKTOP_FORCE_RESTART: 'true',
    },
  })

  electron.once('exit', (code) => {
    void cleanup(code ?? 0)
  })
  electron.once('error', (error) => {
    console.error(error)
    void cleanup(1)
  })

  process.once('SIGINT', () => {
    void cleanup(130)
  })
  process.once('SIGTERM', () => {
    void cleanup(143)
  })
} catch (error) {
  console.error(error)
  await cleanup(1)
}
