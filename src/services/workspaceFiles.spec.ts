import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadWorkspaceFilesModule() {
  vi.resetModules()
  return import('./workspaceFiles')
}

describe('workspace image file URLs', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
    }
  })

  it('resolves markdown-rendered multibyte image paths without double encoding', async () => {
    const workspaceFiles = await loadWorkspaceFilesModule()
    const html = '<p><img src="images/%E4%B8%80%E5%B9%B4%E7%BA%A7%E8%AF%AD%E6%96%87-%E6%97%A5%E6%9C%88%E6%B0%B4%E7%81%AB%E5%B1%B1%E7%94%B0%E9%85%8D%E5%9B%BE.png" alt="Language workbook illustration"></p>'
    const documentPath = decodeURIComponent('%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0/%E4%B8%80%E5%B9%B4%E7%BA%A7%E8%AF%AD%E6%96%87%E5%AD%A6%E4%B9%A0%E6%9D%90%E6%96%99.md')

    const resolved = workspaceFiles.resolveWorkspaceImageSources(
      html,
      documentPath,
    )

    expect(resolved).toContain('http://127.0.0.1:18101/workspace-files/%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0/images/%E4%B8%80%E5%B9%B4%E7%BA%A7%E8%AF%AD%E6%96%87-%E6%97%A5%E6%9C%88%E6%B0%B4%E7%81%AB%E5%B1%B1%E7%94%B0%E9%85%8D%E5%9B%BE.png')
    expect(resolved).not.toContain('%25E4%25B8')
  })

  it('resolves the onboarding logo relative to the welcome document folder', async () => {
    const workspaceFiles = await loadWorkspaceFilesModule()

    const resolved = workspaceFiles.resolveWorkspaceImageSources(
      '<p><img src="logo.png" alt="Kition"></p>',
      'Getting Started/Welcome to Kition.md',
    )

    expect(resolved).toContain(
      'http://127.0.0.1:18101/workspace-files/Getting%20Started/logo.png',
    )
  })

  it('resolves generated Agent images from the workspace root for nested documents', async () => {
    const workspaceFiles = await loadWorkspaceFilesModule()

    const resolved = workspaceFiles.resolveWorkspaceImageURL(
      'Agent/images/9/ig_generated.png',
      'Articles/AI/Attention residue.md',
    )

    expect(resolved).toBe(
      'http://127.0.0.1:18101/workspace-files/Agent/images/9/ig_generated.png',
    )
  })

  it('resolves pasted Attachments images from the workspace root for nested documents', async () => {
    const workspaceFiles = await loadWorkspaceFilesModule()

    const resolved = workspaceFiles.resolveWorkspaceImageURL(
      'Attachments/pasted-image.png',
      'Articles/AI/Attention residue.md',
    )

    expect(resolved).toBe(
      'http://127.0.0.1:18101/workspace-files/Attachments/pasted-image.png',
    )
  })

  it('unwraps angle-bracket Markdown destinations for generated Agent images', async () => {
    const workspaceFiles = await loadWorkspaceFilesModule()

    const resolved = workspaceFiles.resolveWorkspaceImageURL(
      '<Agent/images/9/ig_generated.png>',
      'Articles/AI/Attention residue.md',
    )

    expect(resolved).toBe(
      'http://127.0.0.1:18101/workspace-files/Agent/images/9/ig_generated.png',
    )
  })
})
