/**
 * The compile-time companion list (docs/05 Phase 8A). This file is the ONLY
 * registration point: adding a companion = link: dependency + one import +
 * one registerCompanion() line here (the physics entry below is the pattern).
 */
import { createPhysicsDesktopCompanion } from 'petween-physics/desktop'
import { createRoamerCompanion } from './roamer/companion'
import { createStatsHudCompanion } from './stats-hud/companion'
import { registerCompanion } from './registry'

registerCompanion(createPhysicsDesktopCompanion())
registerCompanion(createStatsHudCompanion())
registerCompanion(createRoamerCompanion())

export { listCompanions, mountEnabledCompanions } from './registry'
export type { DesktopCompanion } from './registry'
