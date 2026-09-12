/** The contextBridge surface exposed by src/preload/index.ts. */
declare global {
  interface Window {
    petweenDesktop: {
      pointerThrough: {
        report(signal: unknown): void
      }
    }
  }
}

export {}
