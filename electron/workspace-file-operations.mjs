import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function isPathWithinRoot(rootPath, targetPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`)
}

export async function assertWorkspacePathSafe(
  rootPath,
  targetPath,
  { allowMissing = false } = {},
) {
  const resolvedRoot = path.resolve(rootPath)
  const resolvedTarget = path.resolve(targetPath)
  if (!isPathWithinRoot(resolvedRoot, resolvedTarget)) {
    throw new Error('workspace path escapes the workspace root')
  }

  const realRoot = await fs.realpath(resolvedRoot)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  const segments = relativePath ? relativePath.split(path.sep).filter(Boolean) : []
  let currentPath = resolvedRoot

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index])
    let stat
    try {
      stat = await fs.lstat(currentPath)
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) {
        const realParent = await fs.realpath(path.dirname(currentPath))
        if (!isPathWithinRoot(realRoot, realParent)) {
          throw new Error('workspace path resolves outside the workspace root')
        }
        return resolvedTarget
      }
      throw error
    }

    if (stat.isSymbolicLink()) {
      throw new Error('symbolic links are not supported inside a workspace path')
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error('workspace path contains a non-directory parent')
    }
  }

  const realTarget = await fs.realpath(resolvedTarget)
  if (!isPathWithinRoot(realRoot, realTarget)) {
    throw new Error('workspace path resolves outside the workspace root')
  }
  return resolvedTarget
}

async function syncParentDirectory(directoryPath) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await fs.open(directoryPath, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      throw error
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writeFileAtomically(filePath, content, options) {
  const directoryPath = path.dirname(filePath)
  const filename = path.basename(filePath)
  await fs.mkdir(directoryPath, { recursive: true })

  let mode = 0o644
  try {
    mode = (await fs.stat(filePath)).mode & 0o777
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const temporaryPath = path.join(
    directoryPath,
    `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', mode)
    await handle.chmod(mode)
    await handle.writeFile(content, options)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryPath, filePath)
    await syncParentDirectory(directoryPath)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function trashWorkspaceDocument(shell, filePath, childFolderPath) {
  await shell.trashItem(filePath)
  try {
    const childStat = await fs.lstat(childFolderPath)
    if (childStat.isDirectory()) {
      await shell.trashItem(childFolderPath)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function trashWorkspaceFolder(shell, folderPath) {
  await shell.trashItem(folderPath)
}
