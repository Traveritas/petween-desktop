/**
 * Overlay renderer entry (~50 lines, docs/02 §3): mount the pure PetOverlay
 * component directly. Never import petween's client/index.ts — that file is
 * the DSH slot/cordis wiring and has no place in the desktop shell.
 *
 * PetOverlay owns its config hub (same-origin root-relative fetches against
 * the local-server — dev via the vite proxy, prod directly) and the
 * OverlaySession lifecycle, so this file only creates the React root.
 *
 * Phase 8: also mounts the enabled desktop companions (pet-behavior modules
 * like physics) next to the stage. The enable map is polled so the settings
 * window's toggles take effect live (full remount on change — rare event).
 */
import { createRoot } from 'react-dom/client'
import { PetOverlay } from 'petween/client/overlay/PetOverlay'
import { petweenClientService } from 'petween/client/extension-service'
import { mountEnabledCompanions } from '../companions'
import { startPointerSignal } from './pointer-signal'

const container = document.getElementById('root')
if (container === null) throw new Error('petween-desktop: #root container missing')

createRoot(container).render(<PetOverlay />)

// Click-through signaling runs outside React: it must survive overlays
// remounting and never depend on component lifecycles.
startPointerSignal()

// Companions: poll the enable map, remount on any change.
let companionDisposer: (() => void) | null = null
let mountedKey = ''
const syncCompanions = (): void => {
  void fetch('/api/petween-desktop/settings')
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { settings?: { companions?: { enabled?: Record<string, boolean> } } } | null) => {
      if (body === null) return
      const key = JSON.stringify(body.settings?.companions?.enabled ?? {})
      if (key === mountedKey) return
      mountedKey = key
      companionDisposer?.()
      companionDisposer = mountEnabledCompanions(petweenClientService, (id) => body.settings?.companions?.enabled?.[id] !== false)
    })
    .catch(() => {})
}
syncCompanions()
setInterval(syncCompanions, 3000)
