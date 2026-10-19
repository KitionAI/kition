import path from 'node:path'
import react from '@vitejs/plugin-react'
import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'
import { defineConfig } from 'vite'
import tailwindConfig from './tailwind.config.ts'
import { aliases, dependenciesFromHere, kition, sdk, web } from './kition.config.ts'

// The kit package is served from wherever a host puts it, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [dependenciesFromHere(), react()],
  css: { postcss: { plugins: [tailwindcss(tailwindConfig), autoprefixer()] } },
  resolve: {
    alias: aliases,
    // One React, one i18next, and one CodeMirror for the page.
    dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
  },
  worker: { format: 'es', plugins: () => [dependenciesFromHere()] },
  server: {
    port: 5192,
    fs: { allow: [web, kition, sdk] },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4096,
    rollupOptions: { input: { index: path.join(web, 'index.html'), dev: path.join(web, 'dev.html') } },
  },
})
