import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { DEV_LOCAL_PORT } from './src/main/dev-port'

/**
 * petween is consumed as raw TS source from the git submodule (a link:
 * dependency). The alias maps the package name onto vendor/petween/src for
 * both main and renderer so `petween/...` deep imports never resolve to the
 * built lib/ outputs, and externalizeDepsPlugin must NOT externalize it —
 * the .ts sources have to be bundled.
 */
const petweenSrc = fileURLToPath(new URL('./vendor/petween/src', import.meta.url))
const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url))

/**
 * Dev same-origin bridge (docs/02 §1): the overlay page is served by this
 * dev server (HMR), so its root-relative petween fetches must be proxied to
 * the main-process local-server on the fixed dev port.
 */
const localServerTarget = `http://127.0.0.1:${DEV_LOCAL_PORT}`

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['petween'] })],
    resolve: {
      alias: { petween: petweenSrc },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // The overlay window keeps sandbox: true, and Electron does not support
      // ESM preload scripts in sandboxed renderers — force CJS output
      // regardless of the package "type": "module".
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: rendererRoot,
    plugins: [react()],
    resolve: {
      alias: { petween: petweenSrc },
    },
    server: {
      proxy: {
        '/api/petween': { target: localServerTarget },
        '/petween-assets': { target: localServerTarget },
      },
    },
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(rendererRoot, 'overlay/index.html'),
        },
      },
    },
  },
})
