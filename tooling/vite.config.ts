import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
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

/**
 * The development server's proxy to a runtime started on its own (`KITION_API_TARGET`). The
 * runtime refuses requests without its API token (contracts/runtime/transport.schema.json), and
 * the page in the web build has none: the proxy adds it, read from the file the runtime writes
 * (`KITION_API_TOKEN_FILE`), to the page's own requests only. A request another site's page sends
 * through this server (`Sec-Fetch-Site` other than `same-origin`) goes on without it and is
 * refused. The `Origin` header is dropped: the runtime allows no development origin of its own.
 */
function runtimeProxy() {
  return {
    target: process.env.KITION_API_TARGET || 'http://127.0.0.1:18101',
    changeOrigin: true,
    secure: false,
    configure: (proxy: { on: (event: 'proxyReq', listener: (request: ClientRequest, incoming: IncomingMessage) => void) => void }) => {
      proxy.on('proxyReq', (request, incoming) => {
        request.removeHeader('origin')
        const site = incoming.headers['sec-fetch-site']
        if (site !== undefined && site !== 'same-origin') return
        const tokenFile = process.env.KITION_API_TOKEN_FILE
        if (!tokenFile) return
        try {
          request.setHeader('Kition-Token', readFileSync(tokenFile, 'utf8').trim())
        } catch {
          // No runtime has written its token yet: the request goes on without it and is refused.
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  root: repositoryDir,
  // Dev servers started side by side (e2e runs on separate ports) each need their own pre-bundled
  // dependencies: one that re-optimizes rewrites the shared folder under another's open pages, which
  // then load two copies of React (an "invalid hook call"). tooling/playwright.config.ts sets this.
  ...(process.env.KITION_VITE_CACHE_DIR ? { cacheDir: process.env.KITION_VITE_CACHE_DIR } : {}),
  publicDir: resolve(repositoryDir, 'public'),
  base: '/',
  // vite-plugin-wasm loads WebAssembly that a module imports as an ES module, as loro-crdt's
  // bundler entry does (see the alias below).
  plugins: [react(), wasm()],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(repositoryDir, 'src') },
      // The packages under packages/ are imported by path alias, not installed (packages/README.md).
      // kition-sdk's @kition/kdm and @kition/kit-engine, which Kition carries as src/lib/kdm and
      // src/lib/kit-engine (scripts/sync-kit-host.mjs).
      { find: /^@kition\/kdm$/, replacement: resolve(repositoryDir, 'src/lib/kdm/index.ts') },
      { find: /^@kition\/kit-engine$/, replacement: resolve(repositoryDir, 'src/lib/kit-engine/index.ts') },
      // loro-crdt's default browser entry downloads and compiles its WebAssembly synchronously on
      // the page's thread. Its bundler entry imports the WebAssembly instead, which
      // vite-plugin-wasm fetches and instantiates asynchronously, in development and in builds
      // alike. Vitest keeps the Node entry (tooling/vitest.config.ts has no such alias).
      { find: /^loro-crdt$/, replacement: 'loro-crdt/bundler' },
    ],
  },
  optimizeDeps: {
    // The app's page only: the dependency scan reads every HTML file under the root otherwise.
    entries: ['index.html'],
    // Search runs in a worker and starts on idle, so Vite's cold-start scanner
    // cannot discover these dependencies from index.html. Pre-bundle them to
    // prevent a full-page reload when the worker starts during renderer E2E.
    // loro-crdt is only reached through dynamic imports for now (the e2e smoke test imports
    // src/lib/kdm), so pre-bundle it as well.
    include: ['@orama/orama', 'idb', 'loro-crdt'],
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
      '/api': runtimeProxy(),
      '/uploads': runtimeProxy(),
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
              test: /\/node_modules\/@kition\/tessera-icons\//,
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
