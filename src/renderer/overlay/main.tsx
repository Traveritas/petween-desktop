/**
 * Overlay renderer entry (~50 lines, docs/02 §3): mount the pure PetOverlay
 * component directly. Never import petween's client/index.ts — that file is
 * the DSH slot/cordis wiring and has no place in the desktop shell.
 *
 * PetOverlay owns its config hub (same-origin root-relative fetches against
 * the local-server — dev via the vite proxy, prod directly) and the
 * OverlaySession lifecycle, so this file only creates the React root.
 */
import { createRoot } from 'react-dom/client'
import { PetOverlay } from 'petween/client/overlay/PetOverlay'
import { startPointerSignal } from './pointer-signal'

const container = document.getElementById('root')
if (container === null) throw new Error('petween-desktop: #root container missing')

createRoot(container).render(<PetOverlay />)

// Click-through signaling runs outside React: it must survive overlays
// remounting and never depend on component lifecycles.
startPointerSignal()
