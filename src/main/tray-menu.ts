/**
 * tray-menu.ts — pure tray template builder. Returns plain data with action
 * IDs (no Electron imports) so the checked/label states are unit-testable;
 * tray.ts maps the IDs to handlers.
 */
export type TrayAction = 'open-settings' | 'open-animator' | 'toggle-auto-launch' | 'import-from-dsh' | 'quit'

export interface TrayMenuState {
  dshConnected: boolean
  autoLaunchEnabled: boolean
  /** false in dev: toggling would register the bare electron.exe binary. */
  canToggleAutoLaunch: boolean
  /** The migration menu entry is offered only while the home is still empty. */
  canImportFromDsh: boolean
}

export interface TrayTemplateItem {
  label?: string
  enabled?: boolean
  type?: 'normal' | 'checkbox' | 'separator'
  checked?: boolean
  action?: TrayAction
}

export function buildTrayTemplate(state: TrayMenuState): TrayTemplateItem[] {
  return [
    { label: state.dshConnected ? 'DSH：已连接' : 'DSH：未连接', enabled: false },
    { type: 'separator' },
    { label: '打开设置…', action: 'open-settings' },
    { label: '动画编辑器…', action: 'open-animator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: state.autoLaunchEnabled,
      enabled: state.canToggleAutoLaunch,
      action: 'toggle-auto-launch',
    },
    ...(state.canImportFromDsh
      ? ([{ label: '从 DSH 导入数据…', action: 'import-from-dsh' }] as TrayTemplateItem[])
      : []),
    { type: 'separator' },
    { label: '退出', action: 'quit' },
  ]
}
