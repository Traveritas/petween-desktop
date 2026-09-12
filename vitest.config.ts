import { defineConfig } from 'vitest/config'

// Main-process tests are plain Node unit tests; Electron is always mocked
// (vi.mock('electron')), never launched (docs/04 §7).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
