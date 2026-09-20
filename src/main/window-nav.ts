/**
 * window-nav.ts — navigation lockdown shared by every shell window (v0.4.0
 * security review): the windows only ever navigate to loopback origins (the
 * vite dev server or the local server), so anything else — file://, a remote
 * page a compromised bundle tried to reach, window.open of any kind — is
 * denied outright. Defence in depth on top of sandbox+contextIsolation: the
 * goal is preserving the "no remote content ever renders in a shell window"
 * invariant, not Node-integration containment (there is none to contain).
 */
import type { BrowserWindow } from 'electron'

function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function lockNavigationToLoopback(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLoopbackUrl(url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}
