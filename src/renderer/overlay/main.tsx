/**
 * Overlay renderer entry (~50 lines, docs/02 §3): mount the pure PetOverlay
 * component directly. Never import petween's client/index.ts — that file is
 * the DSH slot/cordis wiring and has no place in the desktop shell.
 *
 * PetOverlay owns its config hub (same-origin root-relative fetches against
 * the local-server) and the OverlaySession lifecycle, so this file only
 * creates the React root. The hello marker below is a Phase 0 visual check
 * and disappears once the overlay window lands in Phase 2.
 */
import { createRoot } from 'react-dom/client'
import { PetOverlay } from 'petween/client/overlay/PetOverlay'

const container = document.getElementById('root')
if (container === null) throw new Error('petween-desktop: #root container missing')

createRoot(container).render(
  <>
    <div
      data-phase0-hello
      style={{ position: 'fixed', top: 8, left: 8, font: '12px monospace', opacity: 0.7 }}
    >
      petween-desktop phase 0
    </div>
    <PetOverlay />
  </>,
)
