import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('downloads an image without CORS and writes its exact bytes through real desktop IPC', async ({ baseURL }) => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(path.join(tmpdir(), 'kition-image-import-'))
  const bytes = await readFile(path.join(process.cwd(), 'public/logo-mark.png'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const app = await electron.launch({
    executablePath: electronPath, cwd: process.cwd(), args: ['.'],
    env: { ...process.env, KITION_ELECTRON_DEV_SERVER_URL: baseURL!, KITION_DESKTOP_SKIP_API: 'true', KITION_ELECTRON_TEST_DATA_DIR: profile },
  })
  try {
    const page = await app.firstWindow()
    await page.goto(baseURL!, { waitUntil: 'domcontentloaded' })
    const saved = await page.evaluate(async (url) => {
      const bridge = window.kitionDesktop!
      const image = await bridge.ReadRemoteImage!(url)
      const result = await bridge.ImportWorkspaceFile!({ folder: 'attachments', filename: 'download.png', base64_content: image.base64_content })
      const workspace = await bridge.ListWorkspaceDocuments!()
      return { mime: image.mime_type, file: result.imported_path, root: workspace.root_path }
    }, `http://127.0.0.1:${address.port}/image?accessToken=fictional`)
    expect(saved.mime).toBe('image/png')
    expect(saved.file).toBe('attachments/download.png')
    expect(path.relative(profile, saved.root)).not.toMatch(/^\.\./)
    expect(await readFile(path.join(saved.root, saved.file))).toEqual(bytes)
    const snippets = await page.evaluate(async (url) => {
      const modulePath = '/src/features/document/lib/documentImagePaste.ts'
      const { importDocumentClipboardImages } = await import(/* @vite-ignore */ modulePath)
      return Promise.all(['Team A/Plan.md', 'Team B/Plan.md'].map((documentPath) =>
        importDocumentClipboardImages([{ kind: 'source', source: url, alt: 'Diagram' }], { documentPath }),
      ))
    }, `http://127.0.0.1:${address.port}/image`)
    for (const [index, team] of ['Team A', 'Team B'].entries()) {
      const folder = path.join(saved.root, 'attachments', team, 'Plan.md')
      const files = await readdir(folder)
      expect(files).toHaveLength(1)
      expect(await readFile(path.join(folder, files[0]))).toEqual(bytes)
      expect(snippets[index][0]).toContain(`../attachments/${team}/Plan.md/`)
    }

  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(profile, { recursive: true, force: true })
  }
})
