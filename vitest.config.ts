import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const petweenSrc = fileURLToPath(new URL('./vendor/petween/src', import.meta.url))

// Main-process tests are plain Node unit tests; Electron is always mocked
// (vi.mock('electron')), never launched (docs/04 §7). The alias mirrors
// tsconfig paths / electron.vite.config.ts so tests import petween source
// exactly like the app does.
export default defineConfig({
  resolve: {
    alias: { petween: petweenSrc },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
