/**
 * login-item.ts — open-at-login via app.setLoginItemSettings (docs/04 §4).
 * NSIS + non-Squirrel: use process.execPath directly. The open and close
 * calls must pass the IDENTICAL path/args pair or Windows treats them as
 * different Run entries and getLoginItemSettings misreports. The empty args
 * array is written explicitly on both paths for that reason.
 */
import { app } from 'electron'

function loginItemSettings(): { path: string; args: string[] } {
  return { path: process.execPath, args: [] }
}

export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemSettings() })
}

export function getAutoLaunch(): boolean {
  return app.getLoginItemSettings(loginItemSettings()).openAtLogin
}
