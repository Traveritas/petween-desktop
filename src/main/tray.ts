/**
 * tray.ts — the tray icon + menu (docs/04 §4). The Tray instance is held in
 * a module-level reference (a GC'd Tray silently loses its icon). The menu
 * is rebuilt from the pure template whenever DSH status or auto-launch
 * state changes.
 */
import { Menu, Tray, nativeImage, app, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { buildTrayTemplate, type TrayAction, type TrayMenuState } from './tray-menu'

export interface TrayHandlers {
  onAction(action: TrayAction): void
}

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(app.getAppPath(), 'resources', 'tray.png')
}

export function createPetweenTray(handlers: TrayHandlers): {
  update(state: TrayMenuState): void
  destroy(): void
} {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath()))
  tray.setToolTip('Petween')

  const update = (state: TrayMenuState): void => {
    const template: MenuItemConstructorOptions[] = buildTrayTemplate(state).map((item) => {
      if (item.type === 'separator') return { type: 'separator' }
      const action = item.action
      return {
        label: item.label,
        enabled: item.enabled ?? true,
        type: item.type,
        checked: item.checked,
        click: action === undefined ? undefined : () => handlers.onAction(action),
      }
    })
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  return {
    update,
    destroy(): void {
      tray.destroy()
    },
  }
}
