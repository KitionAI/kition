import fs from 'node:fs/promises'

async function deleteDirectoryIfPresent(directoryPath) {
  try {
    const stat = await fs.stat(directoryPath)
    if (stat.isDirectory()) {
      await fs.rm(directoryPath, { recursive: true })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}

export async function deleteWorkspaceDocumentPermanently(filePath, childFolderPath) {
  await fs.rm(filePath)
  await deleteDirectoryIfPresent(childFolderPath)
}

export async function deleteWorkspaceFolderPermanently(folderPath) {
  await fs.rm(folderPath, { recursive: true })
}
