/**
 * Phase 0 placeholder bridge. The pointer-through toggle and window-control
 * channels (whitelisted via contextBridge) arrive in Phase 3.
 */
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('petweenDesktop', { phase: 0 })
