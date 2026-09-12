/**
 * The contextBridge surface (whitelist). The overlay renderer reports
 * pointer-through signals; every channel here is explicit — nothing else
 * crosses the isolation boundary.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petweenDesktop', {
  pointerThrough: {
    report: (signal: unknown): void => {
      ipcRenderer.send('petween:pointer-signal', signal)
    },
  },
})
