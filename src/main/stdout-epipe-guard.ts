/**
 * stdout-epipe-guard.ts — swallow EPIPE on the main process's standard
 * streams. When the app is launched from a script or console whose pipe dies
 * (a background shell that exits, a scheduled task, a service wrapper), every
 * console.log in main would otherwise throw EPIPE as an uncaught exception
 * and pop Electron's "A JavaScript error occurred in the main process"
 * dialog in a loop — pointer-through logs on every click-through state
 * change and the DSH bridge logs on its retry loop, so the dialogs spam.
 * Attaching an 'error' listener keeps the stream from throwing on emit;
 * EPIPE is swallowed (the console is gone — nothing to report to), any other
 * stream error still throws. Electron-free, unit-tested directly.
 */
export interface GuardableStream {
  on?(event: 'error', listener: (error: Error) => void): unknown
}

export function installStdoutEpipeGuard(streams: Array<GuardableStream | null | undefined> = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream?.on?.('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
      throw error
    })
  }
}
