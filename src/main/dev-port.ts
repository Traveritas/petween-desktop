/**
 * The fixed local-server port used in dev so the electron-vite renderer proxy
 * (electron.vite.config.ts) has a stable target. Prod uses a random port.
 * Single source of truth shared by main code and the vite config.
 */
export const DEV_LOCAL_PORT = 17777
