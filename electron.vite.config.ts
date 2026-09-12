import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * petween is consumed as raw TS source from the git submodule (a link:
 * dependency). The alias maps the package name onto vendor/petween/src for
 * both main and renderer so `petween/...` deep imports never resolve to the
 * built lib/ outputs, and externalizeDepsPlugin must NOT externalize it —
 * the .ts sources have to be bundled.
 */
const petweenSrc = fileURLToPath(new URL('./vendor/petween/src', import.meta.url))
const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url))

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
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(rendererRoot, 'overlay/index.html'),
        },
      },
    },
  },
})
