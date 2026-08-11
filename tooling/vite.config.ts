import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readPackageVersion(): string {
  try {
    const raw = readFileSync(resolve(repositoryDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version || 'dev'
  } catch {
    return 'dev'
  }
}

function readGitCommit(): string {
  if (process.env.KITION_BUILD_COMMIT) {
    return process.env.KITION_BUILD_COMMIT
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repositoryDir }).toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

function readBuildIdentity(): string {
  const identity = String(process.env.KITION_BUILD_IDENTITY || 'dev').trim().toLowerCase()
  return identity === 'rc' || identity === 'stable' ? identity : 'dev'
}

function readAnalyticsEndpoint(): string {
  const raw = String(process.env.KITION_ANALYTICS_ENDPOINT || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.toString() : ''
  } catch {
    return ''
  }
}

export default defineConfig(({ mode }) => ({
  root: repositoryDir,
  publicDir: resolve(repositoryDir, 'public'),
  base: process.env.KITION_DESKTOP_BUILD === 'true' ? './' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(repositoryDir, 'src'),
    },
  },
  optimizeDeps: {
    // Search runs in a worker and starts on idle, so Vite's cold-start scanner
    // cannot discover these dependencies from index.html. Pre-bundle them to
    // prevent a full-page reload when the worker starts during renderer E2E.
    include: ['@orama/orama', 'idb'],
  },
  css: {
    postcss: resolve(repositoryDir, 'tooling'),
  },
  define: {
    __APP_VERSION__: JSON.stringify(readPackageVersion()),
    __APP_COMMIT__: JSON.stringify(readGitCommit()),
    __APP_BUILD_AT__: JSON.stringify(new Date().toISOString()),
    __APP_BUILD_IDENTITY__: JSON.stringify(readBuildIdentity()),
    __APP_ANALYTICS_ENDPOINT__: JSON.stringify(readAnalyticsEndpoint()),
    __APP_WEB_PREVIEW__: JSON.stringify(mode === 'web-preview' && !process.env.KITION_API_TARGET),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.KITION_API_TARGET || 'http://127.0.0.1:18101',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: process.env.KITION_API_TARGET || 'http://127.0.0.1:18101',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /\/node_modules\/(?:react|react-dom|react-router|react-router-dom|scheduler)\//,
              priority: 30,
            },
            {
              name: 'icons',
              test: /\/node_modules\/lucide-react\//,
              priority: 20,
            },
            {
              name: 'initial',
              tags: ['$initial'],
              priority: 10,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
}))
