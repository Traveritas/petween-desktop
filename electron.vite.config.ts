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
const physicsSrc = fileURLToPath(new URL('./vendor/petween-physics/src', import.meta.url))
const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url))

/**
 * Dev same-origin bridge (docs/02 §1): the overlay page is served by this
 * dev server (HMR), so its root-relative petween fetches must be proxied to
 * the main-process local-server on the fixed dev port.
 */
const localServerTarget = `http://127.0.0.1:${DEV_LOCAL_PORT}`

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['petween', 'petween-physics'] })],
    resolve: {
      alias: { petween: petweenSrc, 'petween-physics': physicsSrc },
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
      alias: { petween: petweenSrc, 'petween-physics': physicsSrc },
      // vendor/petween is a separate pnpm project with its own node_modules,
      // so its source's bare `react` imports resolve to a second physical
      // copy. Without dedupe the prod bundle carries two Reacts and every
      // petween component dies on mount ("Cannot read properties of null
      // (reading 'useState')" — react-dom of copy A drives copy B's hooks).
      // Dev never hit this because the dev server resolves dep imports from
      // the optimized root graph, but rollup keeps both paths. Always resolve
      // react from THIS project's node_modules.
      dedupe: ['react', 'react-dom'],
    },
    server: {
      proxy: {
        // changeOrigin + origin rewrite: the local server enforces an exact
        // Host whitelist (routes-host, DNS-rebinding fence) AND an Origin↔Host
        // write fence (route-helpers). changeOrigin alone rewrites Host but
        // leaves the browser's Origin (localhost:5173) — every proxied PUT/
        // POST 403ed (real-machine report). The proxy speaks as the target's
        // own origin so both fences see a coherent same-origin request.
        '/api/petween': { target: localServerTarget, changeOrigin: true, headers: { origin: localServerTarget } },
        '/api/petween-desktop': { target: localServerTarget, changeOrigin: true, headers: { origin: localServerTarget } },
        '/api/petween-physics': { target: localServerTarget, changeOrigin: true, headers: { origin: localServerTarget } },
        '/petween-assets': { target: localServerTarget, changeOrigin: true, headers: { origin: localServerTarget } },
      },
    },
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(rendererRoot, 'overlay/index.html'),
          settings: resolve(rendererRoot, 'settings/index.html'),
        },
      },
    },
  },
})
