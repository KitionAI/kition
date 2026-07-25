import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const desktopAppName = 'Kition'
const PROD_PORT = 18101
const DEV_PORT = 18102

function resolveBackendPort() {
  const override = Number.parseInt(String(process.env.KITION_DESKTOP_API_PORT || ''), 10)
  if (Number.isFinite(override) && override > 0) return override
  return app.isPackaged ? PROD_PORT : DEV_PORT
}

function resolveBackendURL() {
  return `http://127.0.0.1:${resolveBackendPort()}`
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function resolveDesktopEnvironment() {
  // On macOS, app.setAppLogsPath() without args uses NSProcessInfo.processName,
  // which is "Electron" in dev mode regardless of app.setName() — pin it explicitly.
  if (process.platform === 'darwin') {
    app.setAppLogsPath(path.join(os.homedir(), 'Library', 'Logs', desktopAppName))
  } else {
    app.setAppLogsPath()
  }

  const dataDir = app.getPath('userData')
  const cacheDir = app.getPath('userCache')
  const logsDir = app.getPath('logs') || path.join(os.homedir(), 'Library', 'Logs', desktopAppName)
  const uploadsDir = path.join(dataDir, 'uploads')
  const exportsDir = path.join(dataDir, 'exports')
  const workspaceDir = path.join(dataDir, 'workspace')
  const sqliteDir = path.join(dataDir, 'data')
  const sqlitePath = path.join(sqliteDir, 'desktop.db')
  const logFile = path.join(logsDir, 'desktop-api.log')

  for (const dir of [dataDir, cacheDir, logsDir, uploadsDir, exportsDir, workspaceDir, sqliteDir]) {
    await ensureDir(dir)
  }

  return {
    platform: process.platform,
    data_dir: dataDir,
    cache_dir: cacheDir,
    logs_dir: logsDir,
    uploads_dir: uploadsDir,
    exports_dir: exportsDir,
    workspace_dir: workspaceDir,
    sqlite_path: sqlitePath,
    log_file: logFile,
    backend_url: resolveBackendURL(),
    backend_port: resolveBackendPort(),
  }
}

export function getBackendBaseURL() {
  return `${resolveBackendURL()}/api`
}

export function getBackendHealthURL() {
  return `${resolveBackendURL()}/health`
}
