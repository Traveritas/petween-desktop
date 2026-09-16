/**
 * The compile-time companion list (docs/05 Phase 8A). This file is the ONLY
 * registration point: adding a companion = link: dependency + one import +
 * one registerCompanion() line here (the physics entry below is the pattern).
 */
import { createPhysicsDesktopCompanion } from 'petween-physics/desktop'
import { registerCompanion } from './registry'

registerCompanion(createPhysicsDesktopCompanion())

export { listCompanions, mountEnabledCompanions } from './registry'
