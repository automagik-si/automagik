import { CompanionStep } from './companion.js'
import { TeamStep } from './team.js'
import { INK_CSS } from './companion-art.js'
import { ONBOARD_CSS } from './onboard-css.js'
import { ConnectAiStep } from './connect-ai.js'
import { MIGRATE_CSS, MigrateStep } from './migrate.js'
import { STAGE_CSS } from './octopus.js'
import { announceStep } from './stage.js'
import { TERMINAL_CSS } from './terminal.js'
import { CLAY_ART_CSS } from './vendor/clay-art.js'
import { PRODUCT_LOCKUP_CSS } from './product-lockup.js'
import { installVeil } from './veil.js'
import { installLocale } from './i18n.js'
import { ACP_CSS, installAcpSection } from './acp-agents.js'
import { installPowerShortcut } from './power-shortcut.js'

// Automagik's onboarding on DSH's settings.onboarding slot. The shell mounts one step at a
// time, in order; these come ahead of DSH's own welcome-notice (-100) and deepseek-official
// (0): create your companion, grow your team, then (with the Omni plugins and Omni on the
// team) the channels plugin's omni-connect (-250), the move from another tool (-230), then
// Connect AI.
const STEPS = [
  { id: 'omni-companion', order: -300, component: CompanionStep },
  { id: 'omni-team', order: -270, component: TeamStep },
  { id: 'omni-migrate', order: -230, component: MigrateStep },
  { id: 'omni-connect-ai', order: -200, component: ConnectAiStep },
]

// The welcome's copy comes from DSH's locale service (i18n.js). The client boot starts entries
// together, so the service can arrive after this plugin applies: declare it, as DSH's own UI
// plugins do, and the shell parks this one until there is a locale to read.
export const inject = ['slots', 'locale']

function installStyles() {
  const style = document.createElement('style')
  style.dataset.omniAi = ''
  style.textContent = STAGE_CSS + ONBOARD_CSS + INK_CSS + CLAY_ART_CSS + PRODUCT_LOCKUP_CSS + TERMINAL_CSS + ACP_CSS + MIGRATE_CSS
  document.head.append(style)
  return () => style.remove()
}

export function apply(ctx) {
  ctx.effect(installStyles, 'omni-ai: stage styles')
  // The welcome's copy, in the DSH language (i18n.js). The locale service is in `inject`, so
  // it is there when this runs; without one, copy stays English.
  ctx.effect(() => installLocale(ctx.get('locale')), 'omni-ai: team step copy')
  ctx.effect(() => installVeil(), 'omni-ai: the table over DSH\'s first frame')
  // ui-settings declares the slot in its own apply, which may run after this one.
  for (const step of STEPS) {
    ctx.effect(() => announceStep(step.id), `omni-ai: ${step.id} on the rail`)
    ctx.slots.inject('settings.onboarding', () => ctx.slots.register({ name: 'settings.onboarding', id: step.id, order: step.order }, step.component))
  }
  ctx.effect(() => installAcpSection(ctx), 'omni-ai: Claude Code and Codex in Settings')
  // Omni's and Genie's power in the Bot team's sidebar, when the Bot team runs here.
  ctx.effect(() => installPowerShortcut(), 'omni-ai: power shortcut in the Bot team sidebar')
}
