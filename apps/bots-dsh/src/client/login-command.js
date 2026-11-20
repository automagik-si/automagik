// `/login` in a Bot's chat (#1754): a client command in the composer's `/` menu (DSH's
// commandUi, kind 'action'). Claude Code and Codex open the same sign-in row Settings opens
// (actions.openCliLogin); any other AI gets a short notice pointing to Settings. Mounted with the
// conversation group, so it is listed only where that row and the notice are drawn.
import { CLI_NAMES } from './cli-login-model.js'
import { providerOfRef, targetOf } from './composer-packs.js'

const LOADING_NOTICE = 'Your team is still loading. Try /login again in a moment.'
const GROUP_NOTICE = "Sign-in runs in a Bot's chat. Open the Bot whose AI you want to sign in."
const NO_MODEL_NOTICE = 'Choose an AI for this Bot first.'
const SETUP_AI_NOTICE = 'Sign-in from the chat is for Claude Code and Codex. Set up this AI in Settings.'
const SETUP_PROVIDER_NOTICE = 'Sign-in from the chat is for Claude Code and Codex. Set up {provider} in Settings.'

const loginNotice = (key, params) => ({ kind: 'notice', key, params })
const isBotChat = (roster, sessionId) => {
  const bot = roster.byId?.[sessionId]
  return Boolean(bot) && bot.kind !== 'dsh'
}

export function loginRoute({ roster, sessionId, actions }) {
  if (!roster?.ready) return loginNotice(LOADING_NOTICE)
  if (roster.roomsById?.[sessionId]) return loginNotice(GROUP_NOTICE)
  if (!isBotChat(roster, sessionId)) return undefined
  const target = targetOf(roster, sessionId)
  if (!target) return loginNotice(NO_MODEL_NOTICE)
  if (target.host !== undefined) return loginNotice(SETUP_AI_NOTICE)
  const { bot, provider } = target
  if (Object.hasOwn(CLI_NAMES, provider)) {
    return typeof actions?.openCliLogin === 'function'
      ? { kind: 'cli', botId: bot.id, provider }
      : loginNotice(SETUP_AI_NOTICE)
  }
  const model = roster.models?.find(model =>
    (model.provider ?? providerOfRef(model.ref)) === provider && model.providerName)
  return loginNotice(SETUP_PROVIDER_NOTICE, { provider: model?.providerName ?? provider })
}

export function loginCommand({ roster, actions, t }) {
  return {
    name: 'login',
    label: () => t('Sign in'),
    description: () => t("Sign in to this chat's AI provider"),
    available({ sessionId }) {
      const view = roster.getSnapshot()
      return !view.ready || isBotChat(view, sessionId) || Boolean(view.roomsById?.[sessionId])
    },
    ui: {
      kind: 'action',
      run({ sessionId }) {
        const route = loginRoute({ roster: roster.getSnapshot(), sessionId, actions })
        if (route?.kind === 'notice') actions.showNotice(t(route.key, route.params))
        else if (route?.kind === 'cli' && actions.openCliLogin(route.botId, route.provider) === false) {
          actions.showNotice(t(SETUP_AI_NOTICE))
        }
      },
    },
  }
}

export function installLoginCommand(ctx, options) {
  const fiber = ctx.inject(['commandUi'], scope => {
    scope.effect(() => scope.commandUi.register(loginCommand(options)), 'ds-bot: /login command')
  })
  return () => fiber.dispose()
}
