import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { currentPart } from './text.js'
import { BoltIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, ConnectorIcon, SearchIcon, SlidersIcon, StarIcon } from './icons.js'
import { FAVORITES, adjacentModelPickerProvider, isMacPlatform, matchesModelSearch, modelJumpIndex, modelJumpLabel, modelPickerModelKey, moveBetweenRows } from './model-picker-t3.js'
import { BotMark } from './mark.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { SPRING_POP, SPRING_SHAPE, spring, stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { HostModelMenu } from './host-model-menu.js'
import { AgentMark, DshMarkIcon, HerdrMarkIcon } from './marks.js'
import { ACP_NAME, commandCapableAgent, crossesHarness, isHermesRoute, routeOf, selectorRouteOf } from '../shared/routes.js'
import { OWN_TOOLS_MENU_HINT, OWN_TOOLS_MODEL_TEXT, ownToolsRefused } from '../shared/own-tools.js'
import { hasSolverSetup, isUnofferedSolverModel } from '../shared/solver-agent.js'
import { HermesMark, HERMES_MARK_CSS } from './hermes-mark.js'
import { HermesRemoteConnect } from './hermes-remote.js'

const MENU_EXIT_MS = 120
const noWork = () => () => {}

// -------------------------------------------------------------------------
// A Bot's model: the picker in its details panel and settings, and the message its
// chat opens on while it has none. Models come from DeepSeek Harness, grouped by provider.

// A connection's name: the brand the host gives (`providerName`) and how it is connected
// (`via`): "OpenAI · API key", "Anthropic · API key"; an agent or DSH's own provider by its
// name alone ("Codex", "Claude Code", "DeepSeek"). "· sign-in" names a DSH sign-in route, shown
// only as a Bot's own model when its CLI covers it (`covered`).
export function connectionOf(model) {
  const provider = model?.providerName ?? model?.provider ?? String(model?.ref ?? '').split('/')[0]
  if (model?.via === 'key') return t('{provider} · API key', { provider })
  if (model?.via === 'signin') return t('{provider} · sign-in', { provider })
  return provider
}

// A model a Bot's chat can start on now: its provider has its key, its sign-in is stored or its
// agent signed in, and no CLI covers its route (the host's catalog marks).
const usableModel = model => !model.needsKey && !model.needsSignIn && !model.covered
const isSolver = bot => bot?.canCancelSolverWait === true || hasSolverSetup(bot)
const solverModel = ({ ref }) => !isUnofferedSolverModel(ref)
// A model a Bot cannot run on: a key or a sign-in is missing, or its plan signs in only
// through its CLI (Claude Code, Codex).
export const unavailableModel = model => model?.needsKey === true || model?.needsSignIn === true || model?.covered === true

// The connection a model belongs to, as a key: its route.
const groupKey = model => model.provider ?? model.providerName ?? model.ref.split('/')[0]

export function groupModels(models) {
  const groups = new Map()
  for (const model of models ?? []) {
    const provider = groupKey(model)
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  const names = new Map()
  for (const list of groups.values()) {
    const name = connectionOf(list[0])
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return [...groups].map(([provider, list]) => {
    const name = connectionOf(list[0])
    return [names.get(name) > 1 ? `${name} (${provider})` : name, list]
  })
}

const servedOf = (roster, ref) => (roster.models ?? []).find(model => model.ref === ref)

// What a Bot runs on, for display: the chosen model, else the one it last ran on.
export function modelOf(bot, roster) {
  const ref = bot.model ?? bot.appliedModel
  if (!ref) return undefined
  const served = servedOf(roster, ref)
  const [, ...rest] = ref.split('/')
  return { ref, name: served ? modelLabel(served) : rest.join('/'), provider: modelRoute(roster, ref).connection, served: served !== undefined, unavailable: served === undefined || unavailableModel(served) }
}

// What a Bot's model really did, from the host's model state (model-state.js): a switch that
// failed and went back, a model that needs a sign-in, or a switch not answered yet. "Answered"
// is never claimed from a pick or a started request. Undefined when there is nothing to say.
export const SWITCH_FAILED = 'MODEL_SWITCH_COMPACTION_FAILED'
export const MODEL_ACCESS_REQUIRED = 'MODEL_ACCESS_REQUIRED'
// An agent switch the Bot's own-tools rule stopped at its commit (#2026, host model-state.js).
export const OWN_TOOLS_SWITCH = 'MODEL_OWN_TOOLS_DENIED'
const labelOf = (roster, ref) => (typeof ref === 'string' ? servedOf(roster, ref)?.name ?? (ref.split('/').slice(1).join('/') || ref) : t('the new model'))
// The agent a ref names, as the menu names it (RFC 0030, Handoff note): an agent over ACP by
// the catalog's brand, else the menu's own name for it; a native model by its catalog name;
// else the ref. Product names are never translated.
export function agentNameOf(roster, ref) {
  if (typeof ref !== 'string' || ref === '') return ''
  const served = servedOf(roster ?? {}, ref)
  const provider = providerOf(served ?? { ref })
  if (routeOf(provider).connectedBy === 'acp') return served?.providerName ?? ACP_NAME[provider] ?? ref
  return served?.name ?? ref
}
export function modelStateLine(state, roster) {
  if (state === undefined || state === null) return undefined
  // An agent switch is running in the Bot's own chat (its chat's composer is locked).
  if (typeof state.switching?.to === 'string') return t('Switching to {agent}…', { agent: agentNameOf(roster, state.switching.to) })
  const failure = state.lastFailure
  if (failure?.kept) {
    const params = { model: labelOf(roster, failure.ref), kept: labelOf(roster, failure.kept) }
    if (failure.code === OWN_TOOLS_SWITCH) return t(OWN_TOOLS_MODEL_TEXT)
    if (failure.code === SWITCH_FAILED) return t('{model} could not take over this conversation. This Bot stays on {kept}.', params)
    if (failure.code === MODEL_ACCESS_REQUIRED) return t('{model} needs a sign-in before it can answer. This Bot stays on {kept}.', params)
    return t('{model} did not answer. This Bot stays on {kept}.', params)
  }
  if (failure?.code === MODEL_ACCESS_REQUIRED && failure.ref === state.selected) return t('{model} needs a sign-in before it can answer.', { model: labelOf(roster, failure.ref) })
  if (state.pending === true) return t('Switching to this model. It has not answered yet.')
  return undefined
}

// The line under a Bot's model in its settings. `state`: the host's model state for this Bot.
export function modelHint(bot, roster, state) {
  // A Bot held at load: its shell is off and its model is a coding CLI that brings its own
  // shell. It does not start until the person picks a native model or turns the shell on.
  if (bot.shellHeld !== undefined) {
    return t('This Bot has no shell, so it cannot run on {cli}, whose own tools can run commands. Pick a model that uses DeepSeek Harness\'s tools, or turn its shell on.', { cli: bot.shellHeld.cli })
  }
  // A Bot whose model its plugin owns: the DSH model saved on it answers nothing. The hint
  // names what answers now, from the plugin's menu, or says nothing.
  const host = roster.hostModels?.[bot.id]
  if (host !== undefined) {
    const answering = host.entries?.find(entry => entry.answering)?.label
    return answering ? t('{model} answers now.', { model: answering }) : null
  }
  const shown = modelOf(bot, roster)
  if (shown === undefined) return t('Pick the model this Bot runs on.')
  // A Bot a subscription move had to leave on its plan route: its shell is off, so the CLI
  // that would bring its own shell cannot take it. The notice names the reason; when the
  // plan route itself is gone, the Bot asks for a model instead of looking like it works.
  const held = bot.subscriptionShellHeld
  if (held !== undefined) {
    if (!shown.served) {
      return t('This model no longer answers, and this Bot cannot move to {cli} while its shell is off. Pick a model that uses DeepSeek Harness\'s tools, or turn its shell on.', { cli: held.cli })
    }
    return t('This Bot stays on {model}: {cli} is a coding CLI that brings its own shell. Turn the shell on, or pick a model that uses DeepSeek Harness\'s tools.', { model: shown.name, cli: held.cli })
  }
  if (!shown.served && (roster.models ?? []).length > 0) return t('This model is not available now. Pick another one.')
  const served = servedOf(roster, shown.ref)
  if (served?.needsSignIn) return t('{model} needs a sign-in before it can answer.', { model: served.name })
  // Signed in on this computer, to an account the person has not confirmed for Bots (#869).
  if (served?.needsAccount) return t('{model} waits for you to confirm its account.', { model: served.name })
  // A plan route whose Bots wait for its CLI (the host's subscription-move.js): the Bot still
  // answers on this model, and moves once the CLI can take it.
  const waiting = served?.covered ? roster.subscriptionWaiting?.[served.provider] : undefined
  if (waiting?.reason === 'sign-in') return t('This Bot stays on {model} until {cli} is signed in.', { model: served.name, cli: waiting.cli })
  if (waiting !== undefined) return t('This Bot stays on {model} until {cli} is ready.', { model: served.name, cli: waiting.cli })
  if (served?.needsKey || served?.covered) return t('This model is not available now. Pick another one.')
  const honest = modelStateLine(state, roster)
  if (honest !== undefined) return honest
  if (bot.appliedModel && bot.appliedModel === bot.model) return t('Every message of this Bot runs on it.')
  return t('Applies from the next message.')
}

// A Bot that waits for a model pick: none chosen, and no plugin answers for it.
export const needsModelPick = (bot, roster) => modelOf(bot, roster) === undefined && roster.hostModels?.[bot.id] === undefined

// The thinking levels of one model, `{efforts, defaultEffort?}`, or null when it has none.
// The catalog carries them for models Bots use; any other ref asks the host once, and the
// answer is kept (a failed ask is not).
const effortCache = new Map()
const effortAsks = new Map()
function askEfforts(ref, actions) {
  if (effortCache.has(ref)) return Promise.resolve(effortCache.get(ref))
  if (actions?.efforts === undefined) return Promise.resolve(null)
  if (!effortAsks.has(ref)) {
    effortAsks.set(ref, Promise.resolve().then(() => actions.efforts(ref)).then((value) => {
      const reasoning = value?.efforts ? value : null
      effortCache.set(ref, reasoning)
      return reasoning
    }, () => null).finally(() => effortAsks.delete(ref)))
  }
  return effortAsks.get(ref)
}
// A model's levels as known now: the catalog's, else a kept answer; undefined while unknown.
const knownEfforts = model => model?.reasoning ?? (effortCache.has(model?.ref) ? effortCache.get(model.ref) : undefined)

function useEfforts(served, ref, actions) {
  const [fetched, setFetched] = useState(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (ref === undefined || served?.reasoning !== undefined || actions?.efforts === undefined) return undefined
    let live = true
    void askEfforts(ref, actions).then((reasoning) => { if (live) setFetched(reasoning) })
    return () => { live = false }
  }, [ref, served?.reasoning !== undefined, actions])
  return served?.reasoning ?? fetched
}

// The rows of a model's levels (the menu's third step): a Default row that clears the Bot's
// pick, then every level the model serves.
export function effortRows(reasoning) {
  if (reasoning?.efforts === undefined || reasoning.efforts.length === 0) return []
  return [
    { effort: undefined, label: t('Default') },
    ...reasoning.efforts.map(effort => ({ effort: effort.id, label: effort.name })),
  ]
}

// A model's name in the menu. An agent's own `default` row carries the agent's name ("Codex"
// under "Codex"): it reads "Default (6.1 Sol)" when the catalog says what that runs on
// (`resolvesTo`, models.js), else "Default".
export function modelLabel(model) {
  const name = model?.name
  const own = model?.id === 'default' || String(model?.ref ?? '').endsWith('/default')
  if (!own || name !== connectionOf(model)) return name
  return model.resolvesTo ? t('Default ({model})', { model: model.resolvesTo }) : t('Default')
}

// The menu offers what is set up: a model that cannot run (no key, no sign-in), one on a route
// a CLI covers (`covered`) and one a newer one of its family replaces
// (`superseded`, Claude's older versions) are left out, unless the Bot is on it. The Bot's own
// model always shows, even one no longer served, and says when it cannot run.
export function offeredModels(models, current) {
  const list = (models ?? []).filter(model => model.ref === current || (model.superseded !== true && usableModel(model)))
  if (typeof current !== 'string' || !current.includes('/') || list.some(model => model.ref === current)) return list
  const [provider, ...rest] = current.split('/')
  return [{ ref: current, provider, name: rest.join('/'), missing: true }, ...list]
}

const offModel = model => model.missing === true || unavailableModel(model)
const Tick = ({ on }) => h('span', { className: 'bt-model-tick', 'aria-hidden': true }, on ? h(CheckIcon) : null)

// The selector's three routes, in the order they are offered (issue #1016). Native is DSH's
// own loop; ACP is every agent acp-dsh serves; Herdr is the agent's own terminal on
// herdr-core, which #1007 wires. The names are UI words; their details say what each means.
export const ROUTE_ORDER = Object.freeze(['native', 'acp', 'herdr', 'hermes-remote'])
const ROUTE_NAME = Object.freeze({ native: 'Native', acp: 'ACP', herdr: 'Herdr', 'hermes-remote': 'Remote Hermes' })
const ROUTE_ICON = Object.freeze({ native: DshMarkIcon, acp: ConnectorIcon, herdr: HerdrMarkIcon, 'hermes-remote': HermesMark })
const routeName = route => t(ROUTE_NAME[route] ?? route)
const routeDetail = (route) => {
  switch (route) {
    case 'acp': return t('Agent Client Protocol')
    case 'herdr': return t('herdr-core terminal')
    case 'hermes-remote': return 'hermes serve'
    default: return t('DSH harness')
  }
}

// The ACP agents in the order the owner names them; any agent acp-dsh adds later follows,
// alphabetical, without a change here.
const ACP_ORDER = Object.freeze(['acp-claude', 'acp-codex', 'acp-hermes', 'acp-antigravity', 'acp-omp'])
export { ACP_NAME }
const providerOf = model => model?.provider ?? String(model?.ref ?? '').split('/')[0]
const routeOfProvider = provider => selectorRouteOf(provider)

// What the menu knows about a model ref: its route, its agent and the connection's name. A
// model no longer served still has a route, read from its provider id.
export function modelRoute(roster, ref) {
  const served = servedOf(roster, ref)
  const provider = providerOf(served ?? { ref })
  const route = served?.route?.connectedBy === 'acp' ? 'acp' : routeOfProvider(provider)
  const remote = roster.prefs?.hermesRemote
  const remoteConnection = remote?.profile || (remote?.mode === 'ssh' ? remote.ssh?.host : remote?.address?.replace(/^https?:\/\//, '').replace(/\/$/, ''))
  return {
    provider,
    route,
    harness: served?.route?.harness ?? routeOf(provider).harness,
    connection: route === 'hermes-remote' ? remoteConnection || routeName(route) : served ? connectionOf(served) : provider,
  }
}

// The routes a Bot may use (RFC 0030 Q13, filled in by the plugin's `routePolicy`): absent,
// all three; otherwise the kind's list, else `default`. No bot type is hard-coded here.
// The first step of the menu: the route. Every open starts here, so the harness is the first
// thing the person sees (issue #1016).
export const MENU_ROOT = Object.freeze({ step: 'routes' })

export function routesFor(bot, roster) {
  const policy = roster?.routePolicy
  if (policy === null || typeof policy !== 'object') return [...ROUTE_ORDER]
  const named = policy[bot?.kind ?? 'automagik'] ?? policy.default
  if (!Array.isArray(named)) return [...ROUTE_ORDER]
  return ROUTE_ORDER.filter(route => named.includes(route))
}

// The agents the owner names, with the models the ACP layer will serve them once #973 lands.
// They are shown as unavailable until acp-dsh actually lists them, so the route names every
// supported agent instead of hiding three behind a plugin version; a catalog row always wins.
const ACP_FALLBACK = Object.freeze({
  'acp-claude': Object.freeze(['default', 'opus', 'sonnet', 'haiku']),
  'acp-codex': Object.freeze(['default']),
  'acp-hermes': Object.freeze(['default']),
  'acp-antigravity': Object.freeze(['default']),
  'acp-omp': Object.freeze(['default']),
})
const pendingAgent = (provider) => ({
  provider,
  name: ACP_NAME[provider] ?? provider,
  pending: true,
  models: (ACP_FALLBACK[provider] ?? []).map(id => ({ id, pending: true })),
})

// The ACP agents the host serves, each with its own models. acp-dsh lists an agent only when
// it is on, so an agent added later appears without a selector change; the named agents it
// does not serve yet stay listed, marked unavailable, until #973 turns them on.
export function acpAgents(models) {
  const groups = new Map()
  for (const model of models ?? []) {
    const provider = providerOf(model)
    if (routeOfProvider(provider) !== 'acp') continue
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  const rank = provider => {
    const at = ACP_ORDER.indexOf(provider)
    return at === -1 ? ACP_ORDER.length : at
  }
  const listed = [...groups].map(([provider, list]) => ({
    provider,
    name: list[0]?.providerName ?? ACP_NAME[provider] ?? connectionOf(list[0]),
    models: list,
  }))
  for (const provider of ACP_ORDER) if (!groups.has(provider)) listed.push(pendingAgent(provider))
  return listed.sort((a, b) => rank(a.provider) - rank(b.provider) || a.name.localeCompare(b.name))
}

// The Native route's models: every DSH model that can be run on, and one that needs an API
// key, which the menu marks and offers to add. A retired sign-in route (`covered`) is not a
// Bot connection, and a superseded model is hidden unless it is the one the Bot is on.
export function nativeModels(models, current) {
  const list = (models ?? []).filter(model => routeOfProvider(providerOf(model)) === 'native'
    && model.covered !== true
    && (model.superseded !== true || model.ref === current))
  if (typeof current !== 'string' || !current.includes('/') || list.some(model => model.ref === current)) return list
  const [provider, ...rest] = current.split('/')
  return [{ ref: current, provider, name: rest.join('/'), missing: true }, ...list]
}

// Herdr's agents and their models, from the pack's own table
// (herdr/mods/am-sidebar/models.js). Herdr cannot run a Bot from this app yet (#1007), so the
// rows are shown, named and disabled rather than hidden: the owner sees what the route will
// offer and rules on it at approval.
const HERDR_AGENTS = Object.freeze([
  Object.freeze({ id: 'claude', name: 'Claude Code', models: Object.freeze(['default', 'opus', 'sonnet', 'haiku']) }),
  Object.freeze({ id: 'codex', name: 'Codex', models: Object.freeze(['default']) }),
  Object.freeze({ id: 'hermes', name: 'Hermes', models: Object.freeze(['default']) }),
  Object.freeze({ id: 'antigravity', name: 'Antigravity', models: Object.freeze(['default']) }),
  Object.freeze({ id: 'omp', name: 'omp', models: Object.freeze(['default']) }),
])
export function herdrAgents() {
  return HERDR_AGENTS.map(agent => ({ ...agent, models: agent.models.map(id => ({ id })) }))
}
const herdrModelLabel = model => (model.id === 'default' ? t('Default') : model.id.charAt(0).toUpperCase() + model.id.slice(1))

// Why a model cannot run, in the menu's words. Undefined: it can run now.
export function modelUnavailableText(model) {
  if (model?.pending === true) return t('Not available yet')
  if (model?.missing === true) return t('Not available')
  if (model?.needsKey === true) return t('Needs an API key')
  if (model?.needsSignIn === true) return t('Needs a sign-in')
  if (model?.needsAccount === true) return t('Needs the account confirmed')
  if (model?.covered === true || model?.superseded === true) return t('Not available')
  return undefined
}

const RouteMark = ({ route }) => h('span', { className: 'bt-route-icon', 'aria-hidden': true }, h(ROUTE_ICON[route] ?? ConnectorIcon, { size: 16 }))
const stepBack = (label, onClick) => h('button', { type: 'button', role: 'menuitem', className: 'bt-model-back', 'aria-label': label, onClick },
  h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, label))

// The stable id of a provider group: the models' provider, never the display name,
// which repeats when two providers carry the same name.
const groupIdOf = list => list[0]?.provider ?? (typeof list[0]?.ref === 'string' ? list[0].ref.split('/')[0] : '')

// The group that holds the Bot's model, by that id; undefined when the model is no
// longer served, or the Bot has none.
function currentGroupId(groups, current) {
  if (current === undefined || current === null) return undefined
  const found = groups.find(([, list]) => list.some(model => model.ref === current))
  return found === undefined ? undefined : groupIdOf(found[1])
}

// A group is open when the user opened or closed it during this opening of the menu.
// Otherwise the current model's provider is open, or the first provider when the model
// is not in the catalog. A search opens every group it matched, so a result is never
// hidden behind a heading, and the manual state applies again once the search clears.
export function groupOpen({ id, index, currentId, filtering, manual }) {
  if (filtering) return true
  const chosen = manual[id]
  if (chosen !== undefined) return chosen
  return currentId === undefined ? index === 0 : id === currentId
}

// The manual state after a heading is clicked, `open` being what the heading showed.
export const toggledGroup = (manual, id, open) => ({ ...manual, [id]: !open })

const NO_MANUAL = {}
// The manual state belongs to one opening of the menu. The leaving menu lives through
// its 120ms exit animation, so a reopen can land on the same mounted rows; asking with
// the new opening number then reads the default again instead of the old choices.
export const manualFor = (state, opening) => (state.opening === opening ? state.manual : NO_MANUAL)

// The rows a step shows (model-menu cascade). The first step is the route, then (ACP and
// Herdr) the agent, then the route's and agent's models, then a model's thinking levels.
// `current` is the Bot's model, `picked` its level when that model serves it, `levelName`
// that level's name. `go(view)` opens another step; `onModel(model, route)` and
// `onLevel(model, effort)` pick; the menu offers the provider's API key where it can.
// `folds` (`{manual, onToggle, filtering?}`): the Native route's providers fold, each under a
// heading that opens and closes it; without it every provider's models show. `levels: false`
// leaves the level step out, for a pick that has no level of its own.
export function ModelSteps({ roster, bot, view, current, picked, levelName, go, onModel, onLevel, onManage, onRemote, folds, levels: withLevels = true }) {
  const models = roster.models ?? []
  const remote = roster.prefs?.hermesRemote
  // A saved Remote Hermes profile lists its models directly; setup is for a first
  // connection, and an explicit manage row below reopens the wizard on purpose.
  const remoteConfigured = remote?.enabled === true && Boolean(remote.profile)
  const currentRoute = current === undefined ? undefined : modelRoute(roster, current).route
  const levelModel = view.step === 'levels' ? models.find(entry => entry.ref === view.ref) : undefined
  const levels = levelModel === undefined ? [] : effortRows(knownEfforts(levelModel))
  if (view.step === 'levels' && levelModel !== undefined && levels.length > 0) {
    const model = levelModel
      const route = view.route ?? modelRoute(roster, model.ref).route
      const agent = acpAgents(models).find(entry => entry.provider === model.provider)
      const label = route === 'native' ? routeName('native') : agent?.name ?? modelRoute(roster, model.ref).connection
      const on = model.ref === current
      return h('div', { key: `levels:${model.ref}`, className: 'bt-model-step', role: 'group', 'aria-label': t('Thinking level') },
        stepBack(t('Back to {agent}', { agent: label }), () => go({ step: 'models', route, ...(model.provider ? { provider: model.provider } : {}) })),
        h('div', { className: 'bt-model-group', role: 'presentation' }, t('Thinking level')),
        levels.map((row) => {
          const checked = on && (row.effort ?? null) === (picked ?? null)
          return h('button', { key: row.effort ?? 'default', type: 'button', role: 'menuitemradio', 'aria-checked': checked, onClick: () => onLevel(model, row.effort) },
            h('span', { className: 'bt-menu-label' }, row.label), h(Tick, { on: checked }))
        }))
  }
  if (view.step === 'models' || view.step === 'levels') {
    const route = view.route ?? routeOfProvider(view.provider)
    const agent = route === 'acp' ? acpAgents(models).find(entry => entry.provider === view.provider) : undefined
    const list = route === 'native' ? nativeModels(models, current)
      : route === 'hermes-remote' ? models.filter(model => providerOf(model) === 'hermes-remote')
      : route === 'acp' ? (agent?.models ?? [])
        : herdrAgents().find(entry => entry.id === view.agent)?.models ?? []
    const direct = route === 'native' || route === 'hermes-remote'
    const back = direct ? { label: t('Back to routes'), view: MENU_ROOT } : { label: t('Back to agents'), view: { step: 'agents', route } }
    const backLabel = direct ? back.label : t('Back to {agent}', { agent: agent?.name ?? routeName(route) })
    const groups = route === 'native' ? groupModels(list) : list.length === 0 ? [] : [[agent?.name ?? routeName(route), list]]
    // One provider has nothing to fold away.
    const folding = route === 'native' && folds !== undefined && groups.length > 1
    const filtering = folds?.filtering === true
    const currentId = folding ? currentGroupId(groups, current) : undefined
    return h('div', { key: `models:${route}:${view.provider ?? view.agent ?? ''}`, className: 'bt-model-step', role: 'group', 'aria-label': t('Models') },
      stepBack(backLabel, () => go(back.view)),
      route === 'hermes-remote' ? h('div', { className: 'bt-model-none' }, t("Your bots’ team tools (messages to other bots, secrets, memory, schedules) are not available in these chats.")) : null,
      route === 'hermes-remote' && list.length === 0
        ? h('div', { className: 'bt-model-none' }, remoteConfigured ? t('No models are known for this connection yet. Manage the connection to list them.') : t('Off by default. Set up Remote Hermes in Bot settings.'))
        : null,
      h('div', { className: 'bt-menu-sep', role: 'separator' }),
      groups.length === 0 ? h('div', { className: 'bt-model-none' }, t('No models are set up for this route yet.')) : null,
      groups.map(([label, entries], index) => {
        const id = groupIdOf(entries)
        const open = !folding || groupOpen({ id, index, currentId, filtering, manual: folds.manual })
        return h(Fragment, { key: folding ? `group:${id || label}` : label },
        !folding || filtering
          ? h('div', { className: 'bt-model-group', role: 'presentation' }, label)
          : h('button', {
              type: 'button', role: 'menuitem', className: 'bt-model-group bt-model-group-toggle',
              'aria-expanded': open, 'data-open': open ? '' : undefined,
              onClick: () => folds.onToggle(id, open),
            },
            h(Caret), h('span', { className: 'bt-menu-label' }, label)),
        open ? entries.map((entry) => {
          const herdr = route === 'herdr'
          const pending = entry.pending === true
          // A Bot that denies acp_tool is not offered a model that runs its own tools (#2026).
          const refused = !herdr && ownToolsRefused(bot, entry)
          const off = herdr || pending || offModel(entry) || refused
          const why = herdr || pending ? t('Not available yet') : refused ? t(OWN_TOOLS_MENU_HINT) : modelUnavailableText(entry)
          const name = herdr ? herdrModelLabel(entry) : modelLabel(entry)
          const more = withLevels && !off && effortRows(knownEfforts(entry)).length > 0
          return h('button', {
            key: entry.ref ?? entry.id, type: 'button', role: 'menuitemradio', 'aria-checked': !herdr && !pending && entry.ref === current,
            title: refused ? t(OWN_TOOLS_MODEL_TEXT) : entry.ref, 'aria-haspopup': more ? 'menu' : undefined,
            'data-unavailable': off ? '' : undefined,
            'aria-label': why ? `${name} · ${why}` : undefined,
            onClick: () => onModel(entry, route),
          },
          h('span', { className: 'bt-menu-label' }, name),
          why ? h('span', { className: 'bt-menu-hint' }, why)
            : entry.ref === roster.defaultModel ? h('span', { className: 'bt-menu-hint' }, t('Default')) : null,
          h(Tick, { on: !herdr && !pending && entry.ref === current }),
          more ? h(ChevronRightIcon) : null)
        }) : null)
      }),
      // An explicit way back to the wizard once the connection is saved: a model row never
      // opens it on its own.
      route === 'hermes-remote' && onRemote
        ? h(Fragment, { key: 'manage' },
          h('div', { className: 'bt-menu-sep', role: 'separator' }),
          h('button', { type: 'button', role: 'menuitem', 'data-manage-connection': '', onClick: () => onRemote(true) },
            h(SlidersIcon), h('span', { className: 'bt-menu-label' }, t('Manage connection…'))))
        : null)
  }
  if (view.step === 'agents') {
    const route = view.route
    const agents = route === 'acp' ? acpAgents(models) : herdrAgents()
    return h('div', { key: `agents:${route}`, className: 'bt-model-step', role: 'group', 'aria-label': t('Agents') },
      stepBack(t('Back to routes'), () => go(MENU_ROOT)),
      h('div', { className: 'bt-model-group', role: 'presentation' }, t('Agents')),
      agents.length === 0 ? h('div', { className: 'bt-model-none' }, route === 'acp' ? t('No ACP agents are set up in DeepSeek Harness yet.') : t('No agents are set up for this route yet.')) : null,
      agents.map((agent) => {
        const herdr = route === 'herdr'
        const pending = agent.pending === true
        const here = route === 'acp' && current !== undefined && current.startsWith(`${agent.provider}/`)
        const signedOut = !herdr && !pending && agent.models.every(entry => offModel(entry)) && agent.models.some(entry => entry.needsSignIn || entry.needsAccount)
        // Every model it serves runs its own tools and the Bot denies acp_tool (#2026). It still
        // opens its model step, where each row says why.
        const ownRefused = !herdr && !pending && !here && agent.models.length > 0 && agent.models.every(entry => ownToolsRefused(bot, entry))
        const why = herdr || pending ? t('Not available yet') : signedOut ? t('Needs a sign-in') : ownRefused ? t(OWN_TOOLS_MENU_HINT) : undefined
        const now = here ? modelLabel(agent.models.find(entry => entry.ref === current) ?? {}) ?? agent.name : undefined
        return h('button', {
          key: agent.provider ?? agent.id, type: 'button', role: 'menuitem', 'aria-haspopup': route === 'hermes-remote' && onRemote ? 'dialog' : 'menu', 'data-current': here ? '' : undefined,
          'data-unavailable': why ? '' : undefined,
          'aria-label': here ? t('{agent}, current model {model}', { agent: agent.name, model: now ?? '' }) : why ? `${agent.name} · ${why}` : agent.name,
          onClick: () => go({ step: 'models', route, ...(agent.provider ? { provider: agent.provider } : { agent: agent.id }) }),
        },
        h(AgentMark, { id: agent.provider ?? agent.id, name: agent.name }),
        h('span', { className: 'bt-menu-label' }, agent.name),
        why ? h('span', { className: 'bt-menu-hint' }, why) : here && levelName ? h('span', { className: 'bt-menu-hint' }, levelName) : null,
        h(Tick, { on: here }),
        herdr || pending ? null : h(ChevronRightIcon))
      }))
  }
  const routes = routesFor(bot, roster)
  return h('div', { key: 'routes', className: 'bt-model-step', role: 'group', 'aria-label': t('Route') },
    routes.length === 0 ? h('div', { className: 'bt-model-none' }, t('No route is available for this Bot.')) : null,
    routes.map((route) => {
      const here = route === currentRoute && current !== undefined
      const rememberedProfile = remote?.enabled ? remote.profile : undefined
      const setup = route === 'hermes-remote' && onRemote !== undefined && !remoteConfigured
      const now = route === 'hermes-remote' && onRemote !== undefined
        ? rememberedProfile || t('Set up')
        : here
        ? [modelRoute(roster, current).connection, levelName].filter(Boolean).join(' · ')
        : route === 'herdr' ? t('Not available yet') : undefined
      return h('button', {
        key: route, type: 'button', role: 'menuitem', 'aria-haspopup': setup ? 'dialog' : 'menu', 'data-current': here ? '' : undefined,
        'data-route': route, 'data-unavailable': route === 'herdr' ? '' : undefined,
        title: route === 'acp' ? t('Agent Client Protocol') : route === 'herdr' ? t('Not available yet') : undefined,
        'aria-label': here ? t('{route}, current model {model}', { route: routeName(route), model: now ?? '' })
          : now ? `${routeName(route)} · ${now}` : `${routeName(route)} · ${routeDetail(route)}`,
        onClick: () => setup ? onRemote() : go(route === 'native' || route === 'hermes-remote' ? { step: 'models', route } : { step: 'agents', route }),
      },
      h(RouteMark, { route }),
      h('span', { className: 'bt-menu-label' }, routeName(route)),
      now ? h('span', { className: 'bt-menu-hint' }, now)
        : h('span', { className: 'bt-menu-hint', 'data-route-detail': '' }, routeDetail(route)),
      h(Tick, { on: here }),
      route === 'herdr' ? null : h(ChevronRightIcon))
    }),
    onManage ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
    onManage ? h('button', { type: 'button', role: 'menuitem', onClick: onManage }, h(SlidersIcon), h('span', { className: 'bt-menu-label' }, t('Models and providers…'))) : null)
}

// The rows a menu's keys move through, in order.
const menuRows = node => [...node.querySelectorAll('[role^="menuitem"]:not(:disabled)')]

export const Caret = () => h('svg', { className: 'bt-model-caret', width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }))

// A menu that opens under its trigger, or above when the window has no room below. A
// click outside, Escape, or a scroll outside it closes it. `onEscape` (a menu with steps)
// handles Escape first, and returns true when it went back a step instead.
// `holdOnScroll`: a scroll outside follows the trigger instead of closing (the running
// question, which an approval card arriving must not close); while the trigger is not
// drawn (no client rects), the menu keeps its last place.
// `clamp`: the menu never runs wider than the window, less a 8px edge on each side (the
// composer's picker, which is wider than a phone).
export function useAnchoredMenu({ onEscape, minWidth = 240, holdOnScroll = false, clamp = false } = {}) {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const escape = useRef(onEscape)
  escape.current = onEscape
  const hold = useRef(holdOnScroll)
  hold.current = holdOnScroll
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (escape.current?.() === true) return
      close()
      button.current?.focus()
    }
    const onScroll = (event) => {
      if (menu.current?.contains(event.target)) return
      if (!hold.current) { close(); return }
      if ((button.current?.getClientRects?.().length ?? 0) > 0) setAnchor({})
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [place])
  const open = () => setAnchor({})
  // Re-reads the trigger's rect whenever the visible viewport moves: the menu
  // tracks its anchor through the on-screen keyboard, not past it.
  useLayoutEffect(() => {
    if (anchor === null || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = clamp ? Math.min(Math.max(minWidth, rect.width), window.innerWidth - 16) : Math.max(minWidth, rect.width)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = viewBottom() - rect.bottom
    setPlace(below >= 260 || below >= rect.top
      ? { left, width, top: rect.bottom + 4, maxHeight: below - 16, '--bt-origin': 'top right' }
      : { left, width, bottom: viewBottom() - rect.top + 4, maxHeight: rect.top - 16, '--bt-origin': 'bottom right' })
  }, [anchor, tick])
  return { isOpen: place !== null, shownPlace, leaving, button, menu, open, close }
}

// The trigger shows the model name over its connection and level. The menu goes in steps:
// the connections that are set up (the current one marked), then one connection's models,
// then a model's thinking levels when it has them; a model without levels applies at once.
// Arrow keys move through a step, Right opens the next, Left and Escape go back one.
// `onPick`/`onPickEffort` replace saving to the Bot, for a Bot that does not exist yet.
// `link`: the trigger is a small "change" link, as in the line under a Bot's greeting.
// `withEfforts: false` keeps the thinking levels out, for a pick that has no level of its own
// (the model new Bots start on).
// A Bot whose model menu its plugin owns gets that menu instead (host-model-menu.js).
export function ModelMenu(props) {
  return h(props.roster?.hostModels?.[props.bot?.id] === undefined ? DshModelMenu : HostModelMenu, props)
}

// What a crossing pick asks first: 'hermes' (the new-conversation question a Hermes route keeps,
// RFC 0030 Q7a), 'running' (the pick stops the reply that runs), or null (switch at once).
export const askFirst = (current, ref, replying) =>
  isHermesRoute(current) || isHermesRoute(ref) ? 'hermes' : replying ? 'running' : null

// Confirm a route or agent change while a reply runs (it stops that reply); a Hermes route
// keeps its new-conversation question.
export function RouteConfirm({ bot, roster, current, target, ask, onCancel, onConfirm }) {
  const from = current === undefined ? undefined : modelRoute(roster, current)
  const to = modelRoute(roster, target.ref)
  const routeChanged = from?.route !== to.route
  // Full access means a different thing on each harness; say which one the Bot is moving to.
  const fullAccess = bot.permission === 'danger-full-access'
  const fullAccessLine = !fullAccess ? undefined
    : to.route === 'native' ? t("Full access: DSH's own tools run without asking.")
      : to.route === 'hermes-remote' ? t('Full access: Hermes still asks you in the chat when it wants an approval. Its own rules apply there.')
      : to.provider === 'acp-claude' || to.provider === 'acp-codex' ? t("Full access: the CLI's own no-ask mode.")
        : t("Full access: the agent's actions run without asking.")
  const title = routeChanged ? t('Change route?') : t('Change agent?')
  const running = ask === 'running'
  return h('div', { className: 'bt-model-step bt-model-confirm', role: 'group', 'aria-label': title },
    h('div', { className: 'bt-model-confirm-title' }, title),
    h('div', { className: 'bt-model-confirm-move' },
      from ? `${routeName(from.route)} · ${from.connection} → ` : '',
      `${routeName(to.route)} · ${to.connection}`),
    h('div', { className: 'bt-model-confirm-text' }, running
      ? t('This stops the current reply and continues on {agent}.', { agent: agentNameOf(roster, target.ref) })
      : routeChanged
        ? t('Changing the route requires a new conversation if this one has history.')
        : t('Changing the agent requires a new conversation if this one has history.')),
    fullAccessLine === undefined ? null : h('div', { className: 'bt-model-confirm-access', role: 'note' }, fullAccessLine),
    h('div', { className: 'bt-model-confirm-actions' },
      h('button', { type: 'button', className: 'bt-model-confirm-cancel', onClick: onCancel }, running ? t('Cancel') : t('Keep this conversation')),
      h('button', { type: 'button', className: 'bt-model-confirm-go', onClick: onConfirm }, running ? t('Switch') : routeChanged ? t('Change route') : t('Change agent'))))
}

// The composer's picker, laid out as T3 Code's (model-picker-t3.js): a rail of providers on
// the left (favorites first), a search box over one provider's models (every provider's while
// searching) with ⌘1…⌘9 on the first nine rows, the shown model's reasoning levels on the right,
// and the Standard / Fast switch in a footer when that model offers it. A route the Bot's kind
// hides is no tab; Herdr and an ACP agent acp-dsh does not serve yet are disabled tabs.
export function pickerTabs(bot, roster, current) {
  const models = roster.models ?? []
  const tabs = []
  for (const route of routesFor(bot, roster)) {
    // The Bot's model is listed as missing on Native only when it is a Native model.
    if (route === 'native') tabs.push({ id: 'native', route, name: routeName('native'), models: nativeModels(models, current !== undefined && modelRoute(roster, current).route === 'native' ? current : undefined) })
    else if (route === 'acp') {
      for (const agent of acpAgents(models)) {
        tabs.push({ id: agent.provider, route, provider: agent.provider, name: agent.name, models: agent.pending ? [] : agent.models, ...(agent.pending ? { disabled: true, why: t('Not available yet') } : {}) })
      }
    } else if (route === 'hermes-remote') tabs.push({ id: 'hermes-remote', route, name: routeName(route), models: models.filter(model => providerOf(model) === 'hermes-remote') })
    else if (route === 'herdr') tabs.push({ id: 'herdr', route, name: routeName('herdr'), models: [], disabled: true, why: t('Not available yet') })
  }
  // What can be picked comes first; what is not available yet stays named, at the end.
  return [...tabs.filter(tab => !tab.disabled), ...tabs.filter(tab => tab.disabled)]
}

// The tab a model is on: its ACP agent's, else its route's.
export const tabOfRef = (tabs, ref) => (typeof ref !== 'string' ? undefined
  : tabs.find(tab => tab.models.some(model => model.ref === ref))?.id)

const FAVORITES_KEY = 'bt-model-favorites'
// The favorite models are this browser's own (as T3 keeps them per environment): a list of refs.
export function readFavorites() {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(FAVORITES_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter(ref => typeof ref === 'string') : []
  } catch { return [] }
}
function writeFavorites(list) {
  try { globalThis.localStorage?.setItem(FAVORITES_KEY, JSON.stringify(list)) } catch { /* private window: kept for this menu only */ }
}

// The rows the list shows: the tab's models, every tab's while searching, the favorites on
// the star. A heading row starts each provider in the Native tab (and each tab's rows while
// searching or on favorites, as T3 groups them).
export function pickerRows({ tabs, tab, query, favorites }) {
  const searching = String(query ?? '').trim() !== ''
  const open = tabs.filter(entry => !entry.disabled)
  const pool = searching || tab === FAVORITES ? open : open.filter(entry => entry.id === tab)
  const rows = []
  for (const entry of pool) {
    const picked = entry.models.filter(model => model.ref !== undefined
      && (tab !== FAVORITES || searching || favorites.includes(model.ref))
      && (!searching || matchesModelSearch(query, [modelLabel(model), model.name, model.ref, model.providerName, entry.name])))
    if (picked.length === 0) continue
    const groups = entry.route === 'native' ? groupModels(picked) : [[entry.name, picked]]
    for (const [label, list] of groups) {
      if (groups.length > 1 || searching || tab === FAVORITES) rows.push({ heading: label, key: `h:${entry.id}:${label}` })
      for (const model of list) rows.push({ key: modelPickerModelKey(entry.id, model.ref), model, tab: entry })
    }
  }
  return rows
}

const BoltMark = () => h('span', { className: 'bt-mp-bolt', 'aria-hidden': true }, h(BoltIcon))
const TabMark = ({ tab, size = 18 }) => (tab.route === 'acp' ? h(AgentMark, { id: tab.provider, name: tab.name, size })
  : tab.route === 'hermes-remote' ? h(HermesMark, { size }) : h(ROUTE_ICON[tab.route] ?? ConnectorIcon, { size }))

// The levels the right column lists for a model: each level the model serves, the model's own
// default marked Default (picking it clears the Bot's level, so the Bot follows the model), and
// a Default row of its own first when the model names no default level.
export function levelRows(reasoning) {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return []
  const own = efforts.some(effort => effort.id === reasoning.defaultEffort) ? reasoning.defaultEffort : undefined
  return [
    ...(own === undefined ? [{ effort: undefined, label: t('Default'), isDefault: true }] : []),
    ...efforts.map(effort => (effort.id === own
      ? { effort: undefined, label: effort.name ?? effort.id, isDefault: true, id: effort.id }
      : { effort: effort.id, label: effort.name ?? effort.id, id: effort.id })),
  ]
}

// The docked picker's own state, as each opening starts it: the tab (the current model's), the
// search, the highlighted row and the model whose levels show (the current one).
const DOCK_START = Object.freeze({ tab: undefined, query: '', highlight: undefined, shown: undefined })
// T3's popup: a 44px rail, the list, and a 192px reasoning column.
const DOCK_WIDTH = 600
const coarsePointer = () => { try { return globalThis.matchMedia?.('(pointer: coarse)')?.matches === true } catch { return false } }
const nextFrame = (run) => { if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run); else run() }

// Whether a model offers Standard / Fast (the host's `speed`, models.js speedOf): true, false,
// or null when unknown. The last answer per model is kept; each opening asks again.
const speedCache = new Map()
function askSpeed(ref, actions) {
  if (typeof ref !== 'string' || typeof actions?.speed !== 'function') return Promise.resolve(null)
  return Promise.resolve().then(() => actions.speed(ref)).then((value) => {
    const offered = value?.offered === true ? true : value?.offered === false ? false : null
    speedCache.set(ref, offered)
    return offered
  }, () => null)
}
export const speedOffered = ref => speedCache.get(ref) ?? null

function DockedPicker({ bot, tabs, state, rows, current, shown, reasoning, picked, speed, favorites, mac, onTab, onQuery, onHighlight, onRowPick, onFavorite, onLevel, onSpeed, onRemote, onManage, onKeyDown, remoteConfigured }) {
  const tab = tabs.find(entry => entry.id === state.tab)
  const searching = state.query.trim() !== ''
  const modelRows = rows.filter(row => row.model)
  const highlighted = modelRows[state.highlight]?.key
  const shownModel = shown === undefined ? undefined : tabs.flatMap(entry => entry.models).find(model => model.ref === shown)
  const levels = levelRows(reasoning)
  // The level the shown model runs on: the Bot's pick on its own model, else the model's default.
  const shownLevel = (shown === current ? picked : undefined)
    ?? (reasoning?.efforts?.some(effort => effort.id === reasoning.defaultEffort) ? reasoning.defaultEffort : undefined)
  const selectedLevel = levels.findIndex(row => row.id === shownLevel || (row.id === undefined && shownLevel === undefined))
  const speedChosen = bot.speed?.model === shown && bot.model === shown ? bot.speed.value : undefined
  const speedLocked = bot.model !== shown
  let jump = 0
  return h('div', { className: 'bt-mp', 'data-model-picker-content': '', onKeyDown },
    h('div', { className: 'bt-mp-body' },
      h('div', { className: 'bt-mp-picker' },
      h('div', { className: 'bt-mp-rail', 'data-model-picker-sidebar': '', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': t('Providers') },
        h('button', { type: 'button', className: 'bt-mp-tab', 'data-model-picker-provider': FAVORITES, 'aria-pressed': state.tab === FAVORITES, 'aria-label': t('Favorites'), title: t('Favorites'), tabIndex: state.tab === FAVORITES ? 0 : -1, onClick: () => onTab(FAVORITES) },
          h(StarIcon, { filled: true })),
        h('div', { className: 'bt-mp-rail-sep', 'aria-hidden': true }),
        tabs.map(entry => h('button', {
          key: entry.id, type: 'button', className: 'bt-mp-tab', 'data-model-picker-provider': entry.id, 'data-route': entry.route,
          'aria-pressed': state.tab === entry.id, disabled: entry.disabled || undefined, tabIndex: state.tab === entry.id ? 0 : -1,
          'aria-label': entry.why ? `${entry.name} · ${entry.why}` : entry.name, title: entry.why ? `${entry.name} · ${entry.why}` : entry.name,
          'data-current': tabOfRef(tabs, current) === entry.id ? '' : undefined,
          onClick: () => (entry.route === 'hermes-remote' && onRemote && !remoteConfigured ? onRemote() : onTab(entry.id)),
        }, h(TabMark, { tab: entry }))),
        onManage ? h('button', { type: 'button', className: 'bt-mp-tab bt-mp-manage', tabIndex: -1, 'aria-label': t('Models and providers…'), title: t('Models and providers…'), onClick: onManage }, h(SlidersIcon)) : null),
      h('div', { className: 'bt-mp-main' },
        h('label', { className: 'bt-mp-search' },
          h(SearchIcon),
          h('input', {
            type: 'text', role: 'combobox', 'aria-expanded': true, 'aria-controls': `bt-mp-list-${bot.id}`, 'aria-autocomplete': 'list',
            'aria-activedescendant': highlighted ? `bt-mp-${bot.id}-${state.highlight}` : undefined,
            'aria-label': t('Search models'), placeholder: t('Search models...'), value: state.query, spellCheck: false, autoComplete: 'off',
            'data-model-picker-search': '', onChange: event => onQuery(event.target.value),
          })),
        h('div', { className: 'bt-mp-list', id: `bt-mp-list-${bot.id}`, role: 'listbox', 'aria-label': searching ? t('Models') : tab?.name ?? t('Favorites') },
          !searching && tab?.route === 'hermes-remote' ? h('div', { className: 'bt-mp-note' }, t("Your bots’ team tools (messages to other bots, secrets, memory, schedules) are not available in these chats.")) : null,
          modelRows.length > 0 ? null : h('div', { className: 'bt-mp-empty' },
            searching ? t('No models match your search.')
              : state.tab === FAVORITES ? t('No favorites yet. Star a model to keep it here.')
                : tab?.route === 'hermes-remote' ? (remoteConfigured ? t('No models are known for this connection yet. Manage the connection to list them.') : t('Off by default. Set up Remote Hermes in Bot settings.'))
                  : t('No models are set up for this route yet.')),
          rows.map((row) => {
            if (row.heading) return h('div', { key: row.key, className: 'bt-mp-heading', role: 'presentation' }, row.heading)
            const index = jump++
            const { model } = row
            const refused = ownToolsRefused(bot, model)
            const why = refused ? t(OWN_TOOLS_MENU_HINT) : modelUnavailableText(model)
            const on = model.ref === current
            const star = favorites.includes(model.ref)
            const label = modelJumpLabel(index, mac)
            const name = modelLabel(model)
            return h('div', {
              key: row.key, id: `bt-mp-${bot.id}-${index}`, role: 'option', className: 'bt-mp-row', 'aria-selected': on,
              'aria-disabled': why ? true : undefined, 'data-highlighted': index === state.highlight ? '' : undefined,
              'data-shown': model.ref === shown ? '' : undefined, 'data-unavailable': why ? '' : undefined, 'data-model-ref': model.ref,
              title: refused ? t(OWN_TOOLS_MODEL_TEXT) : model.ref, 'aria-label': why ? `${name} · ${why}` : undefined,
              onMouseMove: () => { if (index !== state.highlight) onHighlight(index) },
              onClick: () => onRowPick(row),
            },
            h('span', { className: 'bt-mp-row-mark' }, h(TabMark, { tab: row.tab, size: 16 })),
            h('span', { className: 'bt-mp-row-name' }, name),
            on ? h('span', { className: 'bt-mp-row-check', 'aria-hidden': true }, h(CheckIcon)) : null,
            why ? h('span', { className: 'bt-mp-row-hint' }, why)
              : model.ref === bot.defaultModel ? h('span', { className: 'bt-mp-row-hint' }, t('Default')) : null,
            h('button', {
              type: 'button', className: 'bt-mp-star', tabIndex: index === state.highlight ? 0 : -1, 'aria-pressed': star, 'data-on': star ? '' : undefined,
              'aria-label': star ? t('Remove {model} from favorites', { model: name }) : t('Add {model} to favorites', { model: name }),
              onClick: (event) => { event.stopPropagation(); onFavorite(model.ref) },
            }, h(StarIcon, { filled: star })),
            label ? h('kbd', { className: 'bt-mp-kbd' }, label) : null)
          }),
          !searching && tab?.route === 'hermes-remote' && onRemote && remoteConfigured
            ? h('button', { type: 'button', className: 'bt-mp-manage-row', 'data-manage-connection': '', onClick: () => onRemote(true) }, h(SlidersIcon), t('Manage connection…'))
            : null))),
      h('div', { className: 'bt-mp-effort', 'data-model-picker-effort': '' },
        h('div', { className: 'bt-mp-effort-head' },
          h('span', null, t('Reasoning')),
          h('span', { className: 'bt-mp-effort-model' }, shownModel ? modelLabel(shownModel) : '')),
        h('div', { className: 'bt-mp-effort-rows', role: 'radiogroup', 'aria-label': t('Reasoning') },
          shownModel === undefined || reasoning === undefined ? null
            : levels.length === 0 ? h('div', { className: 'bt-mp-effort-none' }, t('No effort levels'))
              : levels.map((row, index) => {
                const checked = index === selectedLevel
                return h('button', {
                  key: row.id ?? 'default', type: 'button', role: 'radio', className: 'bt-mp-level', 'aria-checked': checked,
                  'data-effort-row': '', 'data-effort-level': row.label,
                  tabIndex: (selectedLevel === -1 ? index === 0 : checked) ? 0 : -1,
                  onClick: () => onLevel(shownModel, row.effort),
                },
                h('span', { className: 'bt-mp-level-name' }, row.label),
                checked ? h('span', { className: 'bt-mp-level-check', 'aria-hidden': true }, h(CheckIcon))
                  : row.isDefault && row.id !== undefined ? h('span', { className: 'bt-mp-level-default' }, t('Default')) : null)
              })))),
    speed !== true ? null : h('div', { className: 'bt-mp-foot' },
      h('div', { className: 'bt-mp-speed', role: 'radiogroup', 'aria-label': t('Response speed'), title: speedLocked ? t('Pick this model first, then its speed.') : undefined },
        ['standard', 'fast'].map(value => h('button', {
          key: value, type: 'button', role: 'radio', className: 'bt-mp-segment', 'aria-checked': speedChosen === value,
          'data-checked': speedChosen === value ? '' : undefined, 'data-speed': value, disabled: speedLocked || undefined,
          onClick: () => onSpeed(speedChosen === value ? null : value),
        }, value === 'fast' ? h(BoltMark) : null, value === 'fast' ? t('Fast') : t('Standard'))))))
}

function DshModelMenu({ bot, roster, actions, run, wide = false, link = false, chat = false, bar = false, running = false, onPick, onPickEffort, saved = onPick === undefined, withEfforts = true }) {
  const solver = isSolver(bot)
  // The composer's picker is T3's (DockedPicker); every other place keeps the menu in steps.
  const docked = bar && !link && withEfforts && onPick === undefined
  const [view, setView] = useState(MENU_ROOT)
  const [dock, setDock] = useState(DOCK_START)
  const [favoriteList, setFavoriteList] = useState(undefined)
  const [hermes, setHermes] = useState(false)
  const remote = useRef({ generation: 0, active: false, mounted: true })
  const owner = useRef(bot.id)
  owner.current = bot.id
  useEffect(() => {
    remote.current.mounted = true
    return () => { remote.current.mounted = false; remote.current.active = false; remote.current.generation++ }
  }, [])
  // A crossing while a reply runs, or to or from Hermes, waits for the person's confirmation;
  // an idle crossing goes at once.
  const [confirm, setConfirm] = useState(undefined)
  // The provider's key, for a model that needs one, is asked for inside the menu when the
  // window can save it; elsewhere the row leads to the models page.
  const [keyFor, setKeyFor] = useState(undefined)
  // Levels that arrive for a step on screen draw it again.
  const [, setAsked] = useState(0)
  // Whether the next step takes the focus: the menu was opened or is used from the keyboard.
  const keys = useRef(false)
  const routeOfView = () => view.route ?? (view.provider ? routeOfProvider(view.provider) : 'native')
  const back = () => {
    // Escape on the crossing's word cancels it before it goes back a step.
    if (confirm !== undefined) { setConfirm(undefined); return true }
    if (docked) return false
    if (view.step === 'routes') return false
    keys.current = true
    if (view.step === 'levels') setView({ step: 'models', route: view.route, ...(view.provider ? { provider: view.provider } : {}) })
    else if (view.step === 'models' && routeOfView() !== 'native') setView({ step: 'agents', route: routeOfView() })
    else setView(MENU_ROOT)
    return true
  }
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({ onEscape: back, minWidth: docked ? DOCK_WIDTH : 300, clamp: docked, holdOnScroll: confirm?.ask === 'running' })
  const live = useRef(false)
  live.current = isOpen
  // An agent switch is running in this Bot's own chat (the host's model state): no pick
  // until it ends, and the trigger shows its busy state.
  const switching = useSyncExternalStore(actions?.subscribeWork ?? noWork, () => typeof actions?.modelStateOf?.(bot.id)?.switching?.to === 'string')
  const shown = modelOf(bot, roster)
  const current = bot.model ?? bot.appliedModel
  const currentRef = useRef(current)
  currentRef.current = current
  const currentRoute = current === undefined ? undefined : modelRoute(roster, current)
  const shownRunning = running && bar && current !== undefined && typeof bot.runningModel === 'string' && bot.runningModel !== current
    ? modelOf({ model: bot.runningModel }, roster) : undefined
  const triggerRoute = shownRunning === undefined ? currentRoute : modelRoute(roster, bot.runningModel)
  const runningTitle = shownRunning === undefined ? undefined : t('Running instead of {model}', { model: shown?.name ?? current })
  const served = servedOf(roster, current)
  const reasoning = useEfforts(served, withEfforts ? current : undefined, actions)
  // The level the Bot runs on: its pick when the model serves it, else the model's own.
  const picked = reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  const currentEffort = picked ?? reasoning?.defaultEffort
  const effortLabel = !withEfforts ? undefined : currentEffort === undefined
    ? (reasoning?.efforts?.length > 0 ? t('Default') : undefined)
    : reasoning.efforts.find(effort => effort.id === currentEffort)?.name ?? currentEffort
  const triggerEffort = shownRunning === undefined ? effortLabel
    : servedOf(roster, bot.runningModel)?.reasoning?.efforts?.find(effort => effort.id === bot.runningEffort)?.name
  // Each opening is a new number, so the provider groups start from the current model again
  // even when the previous menu is still playing its exit animation under a quick reopen.
  const [opening, setOpening] = useState(0)
  const [folded, setFolded] = useState({ opening, manual: NO_MANUAL })
  const folds = {
    manual: manualFor(folded, opening),
    onToggle: (id, open) => setFolded(previous => ({ opening, manual: toggledGroup(manualFor(previous, opening), id, open) })),
  }
  // A route's models whose levels the catalog does not carry are asked for as it opens,
  // so each row can say whether a level step follows.
  useEffect(() => {
    if (!withEfforts || !isOpen || view.step !== 'models') return undefined
    let on = true
    const route = view.route ?? routeOfProvider(view.provider)
    const models = solver ? roster.models?.filter(solverModel) : roster.models
    const list = route === 'native' ? nativeModels(models, current)
      : route === 'acp' ? (acpAgents(models).find(agent => agent.provider === view.provider)?.models ?? [])
        : []
    const unknown = list.filter(model => model.ref !== undefined && !offModel(model) && knownEfforts(model) === undefined)
    for (const model of unknown) void askEfforts(model.ref, actions).then(() => { if (on) setAsked(count => count + 1) })
    return () => { on = false }
  }, [isOpen, view, roster.models, current, solver])
  // The step that opens takes the focus when the menu is used from the keyboard (or a row was
  // clicked): its current row, else its first.
  useEffect(() => {
    const node = menu.current
    // The composer's picker opens on its search box, as T3's does (not on a touch screen, where
    // that would raise the keyboard over it).
    if (docked && isOpen && node && confirm === undefined) {
      keys.current = false
      if (!coarsePointer()) node.querySelector('[data-model-picker-search]')?.focus()
      return
    }
    if (!isOpen || !node || !keys.current) return
    keys.current = false
    const rows = menuRows(node)
    ;(rows.find(row => row.getAttribute('aria-checked') === 'true' || row.hasAttribute('data-current')) ?? rows[0])?.focus()
  }, [isOpen, view, confirm])
  const go = (next) => {
    keys.current = Boolean(menu.current?.contains(document.activeElement))
    setView(next)
  }
  const toggle = (event) => {
    if (isOpen) { close(); return }
    // A click with no pointer (Enter, Space) opens the menu with the focus in it.
    keys.current = event?.detail === 0
    setView(MENU_ROOT)
    setDock(DOCK_START)
    setConfirm(undefined)
    setKeyFor(undefined)
    // DSH settings can change the list at any time, so opening asks again.
    void actions?.refreshModels?.()
    setOpening(count => count + 1)
    open()
  }
  const finish = () => {
    const focused = Boolean(menu.current?.contains(document.activeElement))
    close()
    if (focused) button.current?.focus()
  }
  // Only the Bot's own saved model is the same one: with `onPick` the model shown stands in for
  // one the Bot does not have yet, so a level picked on it saves the model too.
  const same = ref => !onPick && ref === current && Boolean(bot.model)
  // A harness crossing: another route, or another ACP agent (RFC 0030, Decided 6 and 10). A
  // first pick, and a model change inside one route, keep the conversation.
  // A Bot already saved (settings, details, the chat bar) crosses; a Bot being created does
  // not: `onPick` alone says nothing about whether the conversation exists yet.
  const crossing = ref => Boolean(current) && saved && ref !== current && crossesHarness(current, ref)
  const recovery = ref => saved && bot.shellHeld !== undefined && !commandCapableAgent(ref)
  // The question the pick needs now: a crossing asks only while a reply runs in the Bot's own
  // chat (that pick stops it), or to or from Hermes.
  const askFor = ref => askFirst(current, ref, actions?.turnRunning?.(currentPart(bot)) === true)
  // The host saw a reply the menu did not (reason reply-running): the same question opens, and
  // nothing changed. Switch sends the pick again with stopReply.
  // `level`: the pick came from a level step, where Default clears the Bot's level.
  const askAgain = (ref, effort, level = false) => (error) => {
    if (error?.reason !== 'reply-running' || owner.current !== bot.id) throw error
    keys.current = true
    setView(MENU_ROOT)
    setConfirm({ ref, effort, ask: 'running', level })
    open()
    return undefined
  }
  const pickModel = (ref, effort, { routeChange = false, level = false, stopReply = false } = {}) => {
    if (switching) return undefined
    // Only the person's Switch on the running question stops a reply (RFC 0030, Handoff note).
    const sending = stopReply ? [{ stopReply: true }] : []
    // A crossing started from a saved Bot's settings still goes through the picker's own
    // action: the settings wrapper needs to keep its sign-in/account handling.
    if (routeChange && typeof onPick === 'function') {
      return Promise.resolve(onPick(ref, { routeChange: true, effort, ...(level ? { level: true } : {}) }, ...sending)).catch(stopReply ? (error) => { throw error } : askAgain(ref, effort, level))
    }
    if (onPick) {
      const pickedIt = Promise.resolve(onPick(ref))
      if (onPickEffort === undefined && effort === undefined) return pickedIt
      return pickedIt.then((done) => {
        if (done === false) return done
        if (onPickEffort) onPickEffort(effort)
        else if (effort !== undefined || bot.effort) void run(actions.updateBot(bot.id, { effort: effort ?? null }))
        return done
      })
    }
    if (!routeChange && same(ref)) {
      if (effort !== bot.effort) void run(actions.updateBot(bot.id, { effort: effort ?? null }))
      return undefined
    }
    if (routeChange) {
      // The host moves a chat with history to a new part with a handoff; a Hermes route still
      // refuses. A reply the menu did not see running comes back as the running question.
      const pick = chat && actions.switchRouteInChat ? actions.switchRouteInChat : actions.switchRoute
      if (typeof pick === 'function') {
        const sent = Promise.resolve(pick(bot.id, ref, level || effort !== undefined ? { effort: effort ?? null } : {}, ...sending))
        return run(stopReply ? sent : sent.catch(askAgain(ref, effort, level)))
      }
    }
    // In a Bot's chat a signed-out agent opens the sign-in row there (cli-login.js, rule 2).
    if (chat && actions.chooseModelInChat) return run(actions.chooseModelInChat(bot.id, ref, level || effort !== undefined ? { effort: effort ?? null } : {}))
    return run(actions.updateBot(bot.id, { model: ref, ...(level || effort !== undefined ? { effort: effort ?? null } : {}) }))
  }
  const commit = (model, effort) => {
    if (switching) return
    let routeChange = model.ref !== undefined && recovery(model.ref)
    if (!routeChange && model.ref !== undefined && crossing(model.ref)) {
      const ask = askFor(model.ref)
      if (ask !== null) { setConfirm({ ref: model.ref, effort, ask }); return }
      routeChange = true
    }
    finish()
    void Promise.resolve(pickModel(model.ref, effort, { routeChange })).catch(() => {})
  }
  // A model with levels opens its level step; one without applies now. Levels not known yet
  // are asked for first. A model that needs an API key asks for it, a signed-out agent opens
  // its sign-in row in the chat, and Herdr's models wait for #1007.
  const onModel = (model, route) => {
    if (route === 'herdr' || model.ref === undefined) return
    // Refused before a sign-in or a key is asked for: no pick, no request (#2026).
    if (ownToolsRefused(bot, model)) return
    if (model.needsKey) {
      if (typeof actions.setProviderKey === 'function') { setKeyFor(model); return }
      const manage = manageModels(actions)
      if (manage) { finish(); manage(); return }
    }
    if (model.needsSignIn || model.needsAccount) {
      if (chat && typeof actions.openCliLogin === 'function') { finish(); actions.openCliLogin(bot.id, model.provider, undefined) }
      return
    }
    if (offModel(model)) return
    if (docked) { pickDocked(model); return }
    if (!withEfforts) { commit(model, undefined); return }
    const decide = (levels) => {
      if (!live.current) return
      if (effortRows(levels).length > 0) go({ step: 'levels', route, ref: model.ref, ...(model.provider ? { provider: model.provider } : {}) })
      else commit(model, undefined)
    }
    const known = knownEfforts(model)
    if (known !== undefined) decide(known)
    else void askEfforts(model.ref, actions).then(decide)
  }
  // A level of the current model changes the level only; on another model, the model and its
  // level go together, and a crossing asks first.
  const onLevel = (model, effort) => {
    if (switching) return
    let routeChange = recovery(model.ref)
    if (!routeChange && crossing(model.ref)) {
      const ask = askFor(model.ref)
      if (ask !== null) { setConfirm({ ref: model.ref, effort, ask, level: true }); return }
      routeChange = true
    }
    // The composer's picker stays open on a level of the same harness, as T3's does.
    if (!docked || routeChange) finish()
    void Promise.resolve(pickModel(model.ref, effort, { routeChange, level: true })).catch(() => {})
  }
  // The composer's picker (T3's): a model of the same harness applies and the picker stays open
  // on its levels; a crossing asks first or switches and closes, as the menu in steps does.
  // The current model only shows its levels: picking it again changes nothing.
  const focusLevels = () => nextFrame(() => {
    const column = menu.current?.querySelector('[data-model-picker-effort]')
    ;(column?.querySelector('[data-effort-row][aria-checked="true"]') ?? column?.querySelector('[data-effort-row]'))?.focus()
  })
  const focusSearch = () => menu.current?.querySelector('[data-model-picker-search]')?.focus()
  const showLevels = (ref) => {
    const model = (roster.models ?? []).find(entry => entry.ref === ref)
    if (model !== undefined && knownEfforts(model) === undefined) void askEfforts(ref, actions).then(() => { if (live.current) { setAsked(count => count + 1); focusLevels() } })
    else focusLevels()
  }
  const pickDocked = (model) => {
    if (switching) return
    if (model.ref === current && bot.model) { setDock(state => ({ ...state, shown: undefined })); showLevels(model.ref); return }
    let routeChange = recovery(model.ref)
    if (!routeChange && crossing(model.ref)) {
      const ask = askFor(model.ref)
      if (ask !== null) { setConfirm({ ref: model.ref, effort: undefined, ask }); return }
      routeChange = true
    }
    if (routeChange) { finish(); void Promise.resolve(pickModel(model.ref, undefined, { routeChange })).catch(() => {}); return }
    setDock(state => ({ ...state, shown: model.ref }))
    showLevels(model.ref)
    void Promise.resolve(pickModel(model.ref, undefined)).then(
      (done) => { if (done === false) setDock(state => (state.shown === model.ref ? { ...state, shown: undefined } : state)) },
      () => setDock(state => (state.shown === model.ref ? { ...state, shown: undefined } : state)))
  }
  const favorites = docked ? favoriteList ?? readFavorites() : []
  const solverRoster = solver ? { ...roster, models: (roster.models ?? []).filter(solverModel) } : roster
  const tabs = docked ? pickerTabs(bot, solverRoster, current) : []
  const startTab = () => tabOfRef(tabs, current) ?? (favorites.some(ref => tabOfRef(tabs, ref) !== undefined) ? FAVORITES : tabs.find(entry => !entry.disabled)?.id ?? FAVORITES)
  const dockTab = dock.tab ?? startTab()
  const dockRows = docked ? pickerRows({ tabs, tab: dockTab, query: dock.query, favorites }) : []
  const dockModels = dockRows.filter(row => row.model)
  const atCurrent = Math.max(0, dockModels.findIndex(row => row.model.ref === current))
  const dockState = { ...dock, tab: dockTab, highlight: Math.min(dock.highlight ?? atCurrent, Math.max(0, dockModels.length - 1)) }
  // The model whose levels and speed show: the one just picked until the Bot is on it, else the Bot's.
  useLayoutEffect(() => {
    if (dock.shown !== undefined && dock.shown === current) setDock(state => ({ ...state, shown: undefined }))
  }, [dock.shown, current])
  const shownRef = dock.shown ?? current
  const shownServed = (roster.models ?? []).find(entry => entry.ref === shownRef)
  const shownReasoning = shownRef === undefined ? undefined : shownRef === current ? reasoning ?? knownEfforts(shownServed) : knownEfforts(shownServed)
  const fastOn = bot.model !== undefined && bot.model === current && bot.speed?.model === current && bot.speed?.value === 'fast' && speedOffered(current) === true
  // A model's levels and speed are asked for when it shows; the Bot's own speed whenever it
  // changes, for the bolt on the trigger.
  useEffect(() => {
    if (!bar) return undefined
    let on = true
    const refs = [...new Set([current, docked && isOpen ? shownRef : undefined].filter(ref => typeof ref === 'string'))]
    for (const ref of refs) void askSpeed(ref, actions).then(() => { if (on) setAsked(count => count + 1) })
    if (docked && isOpen && shownServed !== undefined && knownEfforts(shownServed) === undefined) {
      void askEfforts(shownRef, actions).then(() => { if (on) setAsked(count => count + 1) })
    }
    return () => { on = false }
  }, [bar, docked, isOpen, current, shownRef, opening])
  const dockTo = (tab) => {
    const rows = pickerRows({ tabs, tab, query: '', favorites }).filter(row => row.model)
    setDock(state => ({ ...state, tab, query: '', highlight: Math.max(0, rows.findIndex(row => row.model.ref === current)) }))
  }
  const toggleFavorite = (ref) => {
    const next = favorites.includes(ref) ? favorites.filter(entry => entry !== ref) : [...favorites, ref]
    writeFavorites(next)
    setFavoriteList(next)
  }
  const pickSpeed = (value) => {
    if (switching || bot.model === undefined || bot.model !== shownRef) return
    void Promise.resolve(run(actions.updateBot(bot.id, { speed: value }))).catch(() => {})
  }
  const mac = isMacPlatform()
  const onDockKey = (event) => {
    const jumpTo = modelJumpIndex(event, mac)
    if (jumpTo >= 0) {
      const row = dockModels[jumpTo]
      if (row !== undefined) { event.preventDefault(); event.stopPropagation(); onModel(row.model, row.tab.route) }
      return
    }
    const target = event.target
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey
    if (target?.matches?.('[data-model-picker-search]')) {
      if (event.isComposing || event.keyCode === 229) return
      const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (move !== 0 && plain) {
        event.preventDefault()
        if (dockModels.length > 0) {
          const highlight = Math.min(dockModels.length - 1, Math.max(0, dockState.highlight + move))
          setDock(state => ({ ...state, highlight }))
          menu.current?.querySelectorAll('[role="option"]')[highlight]?.scrollIntoView?.({ block: 'nearest' })
        }
        return
      }
      const highlighted = dockModels[dockState.highlight]
      if (event.key === 'Enter' && highlighted !== undefined) { event.preventDefault(); onModel(highlighted.model, highlighted.tab.route); return }
      if (event.key === 'ArrowRight' && plain && !event.shiftKey && target.selectionStart === dockState.query.length) {
        event.preventDefault()
        if (highlighted !== undefined && highlighted.model.ref !== shownRef) onModel(highlighted.model, highlighted.tab.route)
        else focusLevels()
        return
      }
      if (plain && ((event.key === 'ArrowLeft' && !event.shiftKey && dockState.query.length === 0) || (event.key === 'Tab' && event.shiftKey))) {
        event.preventDefault()
        menu.current?.querySelector('[data-model-picker-provider][aria-pressed="true"]:not(:disabled)')?.focus()
      }
      return
    }
    if (target?.closest?.('[data-model-picker-sidebar]')) {
      const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (move !== 0 && plain) {
        event.preventDefault()
        const next = adjacentModelPickerProvider({ tabs, selected: dockTab, direction: move })
        dockTo(next)
        nextFrame(() => menu.current?.querySelector(`[data-model-picker-provider="${next}"]`)?.focus())
        return
      }
      if (plain && (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey))) { event.preventDefault(); focusSearch() }
      return
    }
    const column = menu.current?.querySelector('[data-model-picker-effort]')
    if (column?.contains(target)) {
      if (event.key === 'ArrowLeft' && plain) { event.preventDefault(); focusSearch(); return }
      moveBetweenRows(event, column)
    }
  }
  const onKeyDown = (event) => {
    const rows = menuRows(event.currentTarget)
    if (rows.length === 0) return
    const at = rows.indexOf(event.target)
    const to = event.key === 'ArrowDown' ? (at + 1) % rows.length
      : event.key === 'ArrowUp' ? (at <= 0 ? rows.length - 1 : at - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : undefined
    if (to !== undefined) { event.preventDefault(); rows[to].focus(); return }
    if (event.key === 'ArrowRight' && at >= 0 && rows[at].getAttribute('aria-haspopup') === 'menu') { event.preventDefault(); keys.current = true; rows[at].click(); return }
    if (event.key === 'ArrowLeft' && back()) event.preventDefault()
  }
  const models = roster.models ?? []
  const manage = manageModels(actions)
  const keyActions = typeof actions.setProviderKey === 'function'
    ? {
        ...actions,
        setProviderKey: (provider, value) => Promise.resolve(actions.setProviderKey(provider, value)).then((done) => {
          if (done !== false) { setKeyFor(undefined); void actions.refreshModels?.() }
          return done
        }),
      }
    : actions
  const bits = shown === undefined ? [] : [...new Set([currentRoute ? routeName(currentRoute.route) : undefined, shown.provider].filter(Boolean))]
  if (shown !== undefined && shown.unavailable && models.length > 0) bits.push(t('not available'))
  else if (effortLabel !== undefined) bits.push(effortLabel)
  const second = bits.length > 0 ? bits.join(' · ') : null
  const confirmView = confirm === undefined ? null : h(RouteConfirm, {
    bot, roster, current, target: confirm, ask: confirm.ask, onCancel: () => setConfirm(undefined),
    onConfirm: () => { const next = confirm; setConfirm(undefined); finish(); void Promise.resolve(pickModel(next.ref, next.effort, { routeChange: true, level: next.level === true, stopReply: next.ask === 'running' })).catch(() => {}) },
  })
  const openRemote = (manage = false) => {
    const generation = ++remote.current.generation
    remote.current.active = true
    remote.current.edit = manage === true
    close()
    setHermes(generation)
  }
  const closeRemote = generation => {
    if (remote.current.generation !== generation) return
    remote.current.active = false
    remote.current.generation++
    setHermes(false)
    button.current?.focus()
  }
  const remoteConnected = async (next, generation) => {
    const current = () => remote.current.mounted && remote.current.active && remote.current.generation === generation && owner.current === bot.id
    if (!current() || typeof next?.modelRef !== 'string') return
    await Promise.resolve(actions.refreshModels?.()).catch(() => {})
    if (!current()) return
    remote.current.active = false
    remote.current.generation++
    setHermes(false)
    // A saved connection comes back naming the model the Bot already runs on: a completed
    // connect never replaces a pick the person already made on this route. An attached serve
    // is the exception: its one model row is the bot's own model, so an older remote model
    // ref must be replaced or the chat would carry a model the new connection cannot serve.
    // A Bot on another route still gets the crossing question, and one without a model the
    // first served model.
    const attached = next.attached === true
    const onRemoteRoute = currentRef.current !== undefined && modelRoute(roster, currentRef.current).route === 'hermes-remote'
    if (onRemoteRoute && !attached) { finish(); return }
    if (crossing(next.modelRef)) {
      keys.current = true
      setView(MENU_ROOT)
      setConfirm({ ref: next.modelRef, effort: undefined, ask: askFor(next.modelRef) ?? 'hermes' })
      open()
    } else {
      finish()
      void Promise.resolve(pickModel(next.modelRef, undefined)).catch(() => {})
    }
  }
  return h(Fragment, null,
    hermes ? h(HermesRemoteConnect, { key: hermes, edit: remote.current.edit === true, more: remote.current.edit === true, onClose: () => closeRemote(hermes), onConnected: next => remoteConnected(next, hermes) }) : null,
    link ? h('button', {
      ref: button, type: 'button', className: 'bt-model-change', 'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-busy': switching || undefined,
      'aria-label': t('Change the model of {name}', { name: bot.name }), onClick: toggle,
    }, t('change')) : h('button', {
      ref: button, type: 'button', className: `bt-model-trigger${bar ? ' bt-model-bar-trigger' : ''}`, 'data-wide': wide || undefined, 'aria-busy': switching || undefined,
      'data-bar': bar || undefined, 'data-route': triggerRoute?.route, 'aria-haspopup': docked ? 'dialog' : 'menu', 'aria-expanded': isOpen,
      'aria-label': t('Model: {model}', { model: shownRunning?.name ?? shown?.name ?? t('none') }) + (bar && fastOn && shownRunning === undefined ? `, ${t('Fast')}` : '') + (runningTitle === undefined ? '' : `. ${runningTitle}`),
      title: runningTitle,
      'data-missing': shown !== undefined && shown.unavailable && models.length > 0 ? '' : undefined, onClick: toggle,
    },
    bar
      ? h('span', { className: 'bt-model-bar' },
        triggerRoute === undefined ? null : h('span', { className: 'bt-model-bar-route', 'aria-hidden': true }, h(ROUTE_ICON[triggerRoute.route] ?? ConnectorIcon, { size: 14 })),
        h('span', { className: 'bt-model-bar-name' }, shownRunning?.name ?? shown?.name ?? t('Choose a model')),
        triggerEffort === undefined ? null : h('span', { className: 'bt-model-bar-effort' }, triggerEffort),
        fastOn && shownRunning === undefined ? h('span', { className: 'bt-model-bar-fast', 'data-fast': '' }, h(BoltMark)) : null,
        shownRunning === undefined ? null : h('span', { className: 'bt-model-bar-effort', 'data-running-instead': '' }, t('instead of {model}', { model: shown?.name ?? current })))
      : h('span', { className: 'bt-model-copy' },
        h('span', { className: 'bt-model-name' }, shown?.name ?? t('Choose a model')),
        second === null ? null : h('span', { className: 'bt-model-provider' }, second)),
    h(Caret)),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-model-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: docked ? 'dialog' : 'menu',
      'aria-label': t('Model for {name}', { name: bot.name }), 'aria-disabled': switching || undefined, style: shownPlace, 'data-leaving': leaving || undefined,
      'data-docked': docked ? '' : undefined, onKeyDown: docked ? (confirm === undefined && keyFor === undefined ? onDockKey : undefined) : onKeyDown,
    },
      docked && confirmView ? h('div', { className: 'bt-mp-confirm' }, confirmView) : confirmView ?? (docked ? DockedPicker({
        bot: { ...bot, defaultModel: roster.defaultModel }, tabs, state: dockState, rows: dockRows, current, shown: shownRef, reasoning: shownReasoning, picked,
        speed: speedOffered(shownRef), favorites, mac, remoteConfigured: roster.prefs?.hermesRemote?.enabled === true && Boolean(roster.prefs?.hermesRemote?.profile),
        onTab: dockTo, onQuery: query => setDock(state => ({ ...state, query, highlight: 0 })),
        onHighlight: index => setDock(state => ({ ...state, highlight: index })),
        onRowPick: row => onModel(row.model, row.tab.route), onFavorite: toggleFavorite, onLevel, onSpeed: pickSpeed,
        onRemote: openRemote, onManage: manage ? () => { finish(); manage() } : undefined,
      }) : null) ?? h(ModelSteps, {
        roster: solver ? { ...roster, models: models.filter(solverModel) } : roster,
        bot, view, current, picked, levelName: effortLabel, go, onModel, onLevel, folds, levels: withEfforts,
        onRemote: openRemote,
        onManage: manage ? () => { finish(); manage() } : undefined,
      }),
      keyFor === undefined ? null : h(ModelKeyCard, { model: keyFor, actions: keyActions })), document.body) : null)
}

// True while a chat holds only the Bot's greeting: its one turn is the one the team started
// (the held kickoff, delivery.js), which DSH's turn outline lists with no prompt of the
// user's, and no one has written in it yet.
const KICKOFF = /^\[Bot team setup\]/
export const greetingOnly = outline => Array.isArray(outline) && outline.length === 1 && (!outline[0]?.prompt || KICKOFF.test(outline[0].prompt))

// What a model is called in a line: its name, its route and its provider's name.
function modelWords(roster, ref) {
  const served = servedOf(roster, ref)
  const info = ref === undefined ? undefined : modelRoute(roster, ref)
  const [provider, ...rest] = String(ref ?? '').split('/')
  return {
    model: served ? modelLabel(served) : rest.join('/'),
    route: info === undefined ? '' : routeName(info.route),
    provider: info?.connection ?? (served ? connectionOf(served) : provider),
  }
}

// One line naming the model a Bot runs on, its route and its provider, with "change"
// opening the model menu (which also leads to the providers): "Using Claude Opus 5.5 ·
// ACP · Claude Code · change". `modelRef` and `onPick` stand in for a model the Bot does
// not have yet (not `ref`: React keeps that prop for itself, issue #153).
export function ModelLine({ bot, roster, actions, run, modelRef, onPick, chat = false }) {
  const words = modelWords(roster, modelRef ?? bot.model ?? bot.appliedModel)
  return h('div', { className: 'bt-model-line' },
    h('span', { className: 'bt-model-line-text' }, words.route === '' || words.route === words.provider
      ? t('Using {model} · {provider}', words)
      : t('Using {model} · {route} · {provider}', words)),
    h('span', { className: 'bt-model-line-sep', 'aria-hidden': true }, '·'),
    h(ModelMenu, { bot: modelRef ? { ...bot, model: modelRef } : bot, roster, actions, run, link: true, chat, onPick }))
}

const outlineOf = (list, sessionId) => list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId?.[sessionId]?.projectionValues?.turnOutline

// Under the Bot's greeting, on its turn's tail, while the chat holds only that greeting:
// the line naming the model the Bot runs on. It goes once anyone writes.
export function ModelLineTail({ turn, sessionId, useRoster, useSessions, actions }) {
  const roster = useRoster(value => value)
  const first = useSessions(list => (greetingOnly(outlineOf(list, sessionId)) ? outlineOf(list, sessionId)[0].turn : null))
  const [error, setError] = useState('')
  const bot = roster.byId[sessionId]
  if (!bot || currentPart(bot) !== sessionId || first === null || first !== turn?.turn) return null
  if (roster.hostModels?.[bot.id] !== undefined) return null
  if (!bot.model || !(roster.models ?? []).some(model => model.ref === bot.model)) return null
  const run = promise => Promise.resolve(promise).then(() => { setError(''); return true }, (failure) => { setError(failure?.message ?? String(failure)); return false })
  return h('div', { className: 'bt-model-tail' },
    h(ModelLine, { bot, roster, actions, run, chat: true }),
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null)
}

// The last turn a chat lists, or null while it has none (a new Bot before its greeting).
const lastTurnOf = outline => (Array.isArray(outline) && outline.length > 0 ? outline.at(-1)?.turn ?? null : null)

// The card a Bot's chat opens on while the Bot has no model, or has one that is no
// longer served. A Bot made without a model holds its greeting until it has one: the
// welcome (@automagik/welcome-dsh) gives the companion and the Omni Bot one once Connect AI
// succeeds, and here one press starts it on the model it would get.
//
// It reads as the Bot's own message, so it stands where a message would (#1138). A chat
// with no turn yet has no transcript, and the card sits in the dock over the composer. A
// chat that already holds turns (a Bot that lost its model, a new part under its earlier
// ones) gets it after its last turn, in the transcript (ModelChoiceTail): the dock is part
// of the composer's seat, which stays in place while the transcript scrolls, so a card
// there lay over the last messages of a chat scrolled up.
export function ModelChoiceDock({ sessionId, useRoster, useSessions, actions }) {
  const seated = useSessions ? useSessions(list => lastTurnOf(outlineOf(list, sessionId)) !== null) : false
  const card = useModelChoice({ sessionId, useRoster, actions }, seated)
  return seated ? null : card
}

// The same card after the chat's last turn, on that turn's tail.
export function ModelChoiceTail({ turn, sessionId, useRoster, useSessions, actions }) {
  const last = useSessions(list => lastTurnOf(outlineOf(list, sessionId)))
  if (last === null || last !== turn?.turn) return null
  return h(ModelChoiceSeat, { sessionId, useRoster, actions })
}

function ModelChoiceSeat(props) {
  const card = useModelChoice(props, false)
  return card ? h('div', { className: 'bt-model-seat' }, card) : null
}

// The card itself, or null when the Bot needs none. `idle`: another place draws it.
function useModelChoice({ sessionId, useRoster, actions }, idle) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // A crossing pick while a reply runs in the chat: the running question, in place of the chips.
  const [asking, setAsking] = useState('')
  // A Bot whose model its plugin picks never waits for a DSH model.
  const hosted = roster.hostModels?.[bot?.id] !== undefined
  const shown = Boolean(bot) && currentPart(bot) === sessionId && roster.ready && !hosted && !idle
  useEffect(() => { if (shown) void actions.refreshModels?.() }, [shown, sessionId])
  if (!shown) return null
  const models = roster.models ?? []
  // A model whose provider has no API key or sign-in fails every turn, so it is no choice;
  // nor is one another connection already offers, nor one on a route this bot type hides.
  const routes = routesFor(bot, roster)
  const eligible = isSolver(bot) ? models.filter(solverModel) : models
  const usable = eligible.filter(usableModel).filter(model => routes.includes(modelRoute(roster, model.ref).route))
  const lost = bot.model ? !models.some(model => model.ref === bot.model) : false
  const run = promise => Promise.resolve(promise).then(() => { setError(''); return true }, (failure) => { setError(failure?.message ?? String(failure)); return false })
  // An unknown catalog (none listed) cannot tell a lost model from a slow provider.
  if (bot.model && (!lost || models.length === 0)) return null
  // A window without DSH's own settings takes the missing key here.
  const keyFor = usable.length === 0 && actions.setProviderKey ? eligible.find(model => model.needsKey) : undefined
  const manage = manageModels(actions)
  // Settles true once the model is saved, so a level picked with it follows (ModelMenu).
  // A crossing while a reply runs in the chat asks first, as the model menu does; only the
  // person's Switch stops the reply (`stopReply`), and the host asks too when it saw a reply
  // the card did not (reason reply-running).
  const pick = (ref, switchNow) => {
    // Only the running question's Switch passes `true` (the menu's onPick passes no second value).
    const stopReply = switchNow === true
    if (!stopReply && bot.model && crossesHarness(bot.model, ref) && actions.turnRunning?.(currentPart(bot)) === true) {
      setAsking(ref)
      return Promise.resolve(false)
    }
    setBusy(ref)
    setError('')
    const sent = !stopReply
      ? (actions.chooseModelInChat ? actions.chooseModelInChat(bot.id, ref) : actions.updateBot(bot.id, { model: ref }))
      : (actions.chooseModelInChat ? actions.chooseModelInChat(bot.id, ref, {}, { stopReply: true }) : actions.updateBot(bot.id, { model: ref, stopReply: true }))
    return Promise.resolve(sent)
      .then(() => true, (failure) => {
        if (failure?.reason === 'reply-running' && !stopReply) {
          setAsking(ref)
          return false
        }
        setError(failure?.message ?? String(failure))
        if (failure?.reason !== 'needs-new-conversation' && failure?.reason !== 'reply-running') void actions.refreshModels?.()
        return false
      })
      .finally(() => setBusy(''))
  }
  // Models that can run and none chosen yet: no grid of choices. The Bot offers the model
  // it would get (DSH's default when it can run, else the first that can), one press
  // starts it, and "change" picks another.
  if (!lost && usable.length > 0) {
    const suggested = usable.find(model => model.ref === roster.defaultModel)?.ref ?? (usable.find(model => model.id !== 'default' && model.superseded !== true) ?? usable.find(model => model.id !== 'default') ?? usable[0]).ref
    return h('div', { className: 'bt-model-dock' },
      h('div', { className: 'bt-astack', 'data-lead': '' },
        h('div', { className: 'bt-msg' },
          h('div', { className: 'bt-msg-line' },
            h(BotMark, { bot, size: 22 }),
            h('div', { className: 'bt-bubble' }, t("Hi, I'm {name}. Say when, and I'll start.", { name: bot.name }))))),
      h('div', { className: 'bt-model-offer' },
        h('button', {
          type: 'button', className: 'bt-model-chip bt-model-start', disabled: busy !== '', 'aria-busy': busy === suggested || undefined,
          onClick: () => pick(suggested),
        }, t('Start'), busy === suggested ? h('span', { className: 'bt-model-spin', 'aria-label': t('Saving…') }) : null),
        h(ModelLine, { bot, roster, actions, run, modelRef: suggested, onPick: pick })),
      error ? h('div', { className: 'bt-secret-error bt-model-error', role: 'alert' }, error) : null)
  }
  // The recovery cases: the model went away, a key is missing, or nothing is set up. The
  // pick reads as the Bot's own first message, with the choices as replies under it.
  const text = lost
    ? t('{model} is not available anymore. Pick another model for me.', { model: bot.model.split('/').slice(1).join('/') })
    : keyFor
      ? t("Hi, I'm {name}. I need a {provider} API key before I can start.", { name: bot.name, provider: keyFor.providerName ?? keyFor.provider })
      : t("Hi, I'm {name}. I don't have a model yet. How do you want to set one up?", { name: bot.name })
  const choices = usable.length === 0
    ? setupChoices(actions).map(([label, run]) => h('button', { key: label, type: 'button', className: 'bt-model-chip', onClick: run }, label))
    : [
        ...groupModels(usable).map(([provider, list]) => h('div', { key: list[0].provider ?? provider, className: 'bt-model-choice-group', role: 'group', 'aria-label': provider },
          h('div', { className: 'bt-model-choice-provider', 'aria-hidden': true }, `${routeName(modelRoute(roster, list[0].ref).route)} · ${provider}`),
          h('div', { className: 'bt-model-choice-chips' }, list.map(model => h('button', {
            key: model.ref, type: 'button', className: 'bt-model-chip', disabled: busy !== '', 'aria-busy': busy === model.ref || undefined,
            'aria-label': `${modelLabel(model)} · ${routeName(modelRoute(roster, model.ref).route)} · ${provider}`,
            title: model.ref === roster.defaultModel ? `${model.ref} · ${t('Harness default')}` : model.ref,
            onClick: () => pick(model.ref),
          }, modelLabel(model), busy === model.ref ? h('span', { className: 'bt-model-spin', 'aria-label': t('Saving…') }) : null))))),
        manage ? h('button', { key: 'manage', type: 'button', className: 'bt-model-chip bt-model-chip-quiet', onClick: manage }, h(SlidersIcon), t('Manage models')) : null,
      ]
  return h('div', { className: 'bt-model-dock' },
    h('div', { className: 'bt-astack', 'data-lead': '' },
      h('div', { className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          h(BotMark, { bot, size: 22 }),
          h('div', { className: 'bt-bubble' }, text)))),
    keyFor
      ? h(ModelKeyCard, { key: keyFor.provider, model: keyFor, actions })
      : asking !== ''
        ? h(RouteConfirm, {
          bot, roster, current: bot.model, target: { ref: asking }, ask: 'running',
          onCancel: () => setAsking(''),
          onConfirm: () => { const ref = asking; setAsking(''); void pick(ref, true) },
        })
        : h('div', { className: 'bt-model-chips', role: 'group', 'aria-label': t('Choose a model') }, choices),
    error ? h('div', { className: 'bt-secret-error bt-model-error', role: 'alert' }, error) : null)
}

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'

// The provider's API key, saved through the host; once it is set, the provider's
// models become the choices. `onSaved` runs once the host took the key.
export function ModelKeyCard({ model, actions, onSaved }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = t('{provider} API key', { provider: model.providerName ?? model.provider })
  const ready = value.trim() !== '' && !busy
  const save = () => {
    if (!ready) return
    setBusy(true)
    setError('')
    void Promise.resolve(actions.setProviderKey(model.provider, value))
      .then(() => { setValue(''); onSaved?.() }, failure => setError(hostText(failure?.message ?? String(failure))))
      .finally(() => setBusy(false))
  }
  const official = model.provider === 'deepseek-official'
  return h('div', { className: 'bt-q bt-model-key', role: 'group', 'aria-label': label },
    h('div', { className: 'bt-model-key-title' }, h(KeyIcon), label),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label, autoFocus: true })),
    official ? h('div', { className: 'bt-model-key-help' },
      h('a', { className: 'bt-model-key-link', href: DEEPSEEK_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, t('Create a key on the DeepSeek platform ↗')),
      h('span', { className: 'bt-model-key-note' }, t('The API is billed by usage; the account needs a balance first.'))) : null,
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      actions.openModels ? h('button', { type: 'button', className: 'bt-q-btn bt-model-key-other', onClick: actions.openModels }, t('Another provider')) : null,
      h('button', { type: 'button', className: 'bt-q-submit', disabled: !ready, onClick: save }, busy ? t('Saving…') : t('Save'))))
}

// Where the providers are set up: the window's own Models page, else DSH's settings.
export const manageModels = actions => actions.openModels ?? actions.openHarnessSettings

// Ways to get a first model. Connect an AI is the welcome plugin's step (@automagik/welcome-dsh:
// a subscription sign-in, an API key or a gateway); the DeepSeek sign-in exists only where
// the shell carries its account plugin (the Desktop); the API key and custom models use the
// shell's own editors.
function setupChoices(actions) {
  return [
    actions.openHarnessOnboarding ? [t('Connect an AI: ChatGPT, Claude, Kimi or an API key'), () => actions.openHarnessOnboarding('omni-connect-ai')] : null,
    actions.canSignIn?.() ? [t('Sign in to DeepSeek'), () => actions.signIn()] : null,
    actions.openHarnessOnboarding ? [t('Enter a DeepSeek API key'), () => actions.openHarnessOnboarding('deepseek-official')] : null,
    actions.openHarnessSettings ? [t('Open settings to set up a custom model'), actions.openHarnessSettings] : null,
  ].filter(Boolean)
}

// The shell's own DeepSeek sign-in dialog, borrowed from its account plugin: the
// plugin's model sign-in entry renders here with the plugin's own operations.
export function DeepSeekSignIn({ useUi, actions }) {
  const open = useUi(state => state.signIn)
  const entry = open ? actions.signInEntry?.() : null
  if (!entry) return null
  return h(SignInHost, { key: open, entry, actions })
}

function SignInHost({ entry, actions }) {
  const [ops] = useState(() => entry.inject?.() ?? {})
  const close = () => actions.closeSignIn()
  const useHook = source => selector => useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
  const [hooks] = useState(() => ({ useAccount: useHook(ops.hooks.account), useTheme: useHook(ops.hooks.theme) }))
  return h(entry.component, {
    ...ops,
    ...hooks,
    t: actions.accountT(),
    complete: close,
    useApiKey: () => { close(); actions.openHarnessOnboarding('deepseek-official') },
  })
}

export const MODEL_CSS = `${HERMES_MARK_CSS}
.bt-model-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;height:auto;min-height:32px;padding:4px 8px 4px 10px;border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-model-trigger:hover,.bt-model-trigger[aria-expanded=true]{background:var(--bt-active)}
.bt-model-trigger:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-trigger[data-missing] .bt-model-provider{color:var(--st-bad-strong,var(--bt-danger))}
.bt-model-trigger[data-wide]{display:flex;width:100%;min-height:48px;padding:7px 12px;justify-content:space-between;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-model-trigger[data-wide]:hover,.bt-model-trigger[data-wide][aria-expanded=true]{background:var(--bt-hover)}
.bt-model-copy{display:flex;flex-direction:column;min-width:0}
.bt-model-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-provider{font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-model-trigger[aria-expanded=true] .bt-model-caret{transform:rotate(180deg)}
.bt-model-menu{overflow-y:auto;scrollbar-width:thin}
.bt-model-group{flex:none;padding:8px 8px 2px;font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3);text-transform:none}
.bt-model-group:first-child{padding-top:2px}
/* A heading that opens and closes its group: the same type as the plain headings other
menus use, with the menu item's hover, focus ring and a caret that points at the state. */
.bt-model-group-toggle{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:0;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:11px;line-height:14px;font-weight:500;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-model-group-toggle:hover{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-model-group-toggle:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-group-toggle .bt-model-caret{color:inherit}
.bt-model-group-toggle[aria-expanded=false] .bt-model-caret{transform:rotate(-90deg)}
.bt-model-tick{flex:none;width:16px;height:16px;display:inline-flex;color:var(--bt-ink-2)}
.bt-model-tick svg{animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} 60ms backwards}
.bt-model-none{padding:8px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-model-step{display:flex;flex-direction:column;gap:2px;min-width:0;animation:bt-veil-in .14s ease-out}
.bt-model-menu .bt-model-step .bt-menu-hint{min-width:0;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-menu .bt-model-step > button > svg:last-child:not(:first-child){color:var(--bt-ink-3)}
.bt-menu .bt-model-back{color:var(--bt-ink-2);font-weight:500}
.bt-model-menu .bt-model-step button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-host-model-copy{display:flex;flex-direction:column;flex:1;min-width:0}
.bt-host-model-detail{font-size:11px;line-height:14px;color:var(--bt-ink-3);white-space:normal}
.bt-host-model-status{padding:2px 8px 6px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-host-model-confirm{flex:none;color:var(--bt-accent);font-size:12px;font-weight:600}
/* DSH centers the message column inside its scroll padding, which can sit a few px off this dock's center; the side shadows keep the band over the column's edges. */
.bt-model-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 0 10px;box-sizing:border-box;background:var(--bt-main);box-shadow:-12px 0 0 var(--bt-main),12px 0 0 var(--bt-main);animation:bt-model-in ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
/* After the last turn of a transcript the card is one more message: the column's width, and
   the room a message has above it. */
.bt-model-seat{margin:6px 0 4px}
.bt-model-seat>.bt-model-dock{max-width:none;margin:0;padding:0}
/* The scroll box clips at its padding edge, so 3px of padding keeps the chips' focus rings visible; the negative margins cancel it so the chips stay in place. */
.bt-model-chips{display:flex;flex-wrap:wrap;gap:6px;box-sizing:border-box;padding:3px;margin:-3px 0 -3px 27px;max-width:min(566px,calc(100% - 27px));max-height:min(246px,calc(36vh + 6px));max-height:min(246px,calc(36dvh + 6px));overflow-y:auto;scrollbar-width:thin}
.bt-model-choice-group{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0}
.bt-model-choice-provider{padding-top:4px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-model-choice-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-model-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 12px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-surface,transparent);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.bt-model-chip:hover:not(:disabled){background:var(--bt-hover)}
.bt-model-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-chip-quiet{color:var(--bt-ink-2)}
.bt-model-chip svg{width:14px;height:14px}
.bt-model-chip:disabled{cursor:default}
.bt-model-chip:disabled:not([aria-busy]){opacity:.5}
.bt-model-error{margin-left:30px}
.bt-model-tail{margin:2px 0 6px 6px}
.bt-model-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 6px;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-model-line-text{min-width:0;overflow-wrap:anywhere}
.bt-model-line-sep{color:var(--bt-ink-3)}
.bt-model-change{padding:0;border:0;background:none;color:var(--bt-accent);font:inherit;font-weight:600;cursor:pointer}
.bt-model-change:hover,.bt-model-change[aria-expanded=true]{text-decoration:underline;text-underline-offset:3px}
.bt-model-change:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-model-offer{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;margin-left:30px}
.bt-model-offer .bt-model-line{margin-left:0}
.bt-q.bt-model-key{margin:0 0 0 30px;width:min(480px,calc(100% - 30px));gap:10px}
.bt-model-key-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink-2)}
.bt-model-key-title svg{flex:none;width:16px;height:16px}
.bt-model-key .bt-q-foot{margin-top:2px}
.bt-model-key-help{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-model-key-link{align-self:flex-start;color:var(--bt-ink);text-decoration:underline;text-decoration-color:var(--bt-line-2);text-underline-offset:2px}
.bt-model-key-link:hover{text-decoration-color:currentColor}
.bt-model-key-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px;border-radius:4px}
.bt-model-key-other{margin-right:auto}
.bt-route-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--bt-ink-2)}
.bt-route-icon svg{width:16px;height:16px}
.bt-model-step>[data-route=acp] .bt-route-icon{color:var(--bt-accent)}
.bt-model-step>[data-route=hermes-remote] .bt-menu-label{flex:none}
.bt-agent-mark{flex:none;display:block;border-radius:4px;object-fit:contain}
.bt-agent-initial{flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-weight:600;line-height:1}
.bt-model-menu .bt-model-step .bt-menu-label{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink)}
.bt-model-menu .bt-model-step .bt-menu-hint{font-size:12px;color:var(--bt-ink-2)}
.bt-model-menu .bt-model-step .bt-model-group{font-size:12px;font-weight:600;color:var(--bt-ink-2)}
.bt-model-step>[data-unavailable]{color:var(--bt-ink-2)}
.bt-model-step>[data-unavailable] .bt-menu-label{color:var(--bt-ink-2);font-weight:500}
.bt-model-step>[data-unavailable] :is(.bt-route-icon,.bt-agent-mark,.bt-agent-initial){opacity:.6}
.bt-model-step .bt-menu-hint[data-route-detail]{max-width:64%;overflow:visible;text-align:right;white-space:normal;line-height:14px;font-style:italic}
.bt-model-step>[data-route=hermes-remote] .bt-menu-hint{flex:1;max-width:none;white-space:nowrap}
.bt-model-confirm{padding:10px 10px 8px;gap:8px}
.bt-model-confirm-title{font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink)}
.bt-model-confirm-move{font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-model-confirm-text{padding:2px 0 6px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-model-confirm-access{padding:0 0 6px;font-size:12px;line-height:17px;color:var(--st-bad-strong,var(--bt-danger))}
.bt-model-confirm-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-menu .bt-model-confirm-actions .bt-model-confirm-cancel,.bt-menu .bt-model-confirm-actions .bt-model-confirm-go{width:auto;min-height:30px;padding:5px 12px;border-radius:999px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.bt-menu .bt-model-confirm-actions .bt-model-confirm-cancel{border:.5px solid var(--bt-line-2);background:var(--bt-main);color:var(--bt-ink-2)}
.bt-menu .bt-model-confirm-actions .bt-model-confirm-go{border:.5px solid transparent;background:var(--bt-accent);color:var(--bt-accent-ink);font-weight:600}
.bt-menu .bt-model-confirm-actions .bt-model-confirm-cancel:hover{background:var(--bt-hover)}
.bt-menu .bt-model-confirm-actions .bt-model-confirm-go:hover{filter:brightness(0.96)}
.bt-model-confirm-cancel:focus-visible,.bt-model-confirm-go:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
@keyframes bt-model-in{from{opacity:0;transform:translateY(6px)}}
.bt-model-spin{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--bt-line-2);border-top-color:var(--bt-ink-2);animation:bt-model-spin .7s linear infinite}
@keyframes bt-model-spin{to{transform:rotate(360deg)}}
/* The composer's picker, laid out as T3 Code's (model-picker-t3.js): rail, search and list,
   reasoning column, speed footer. One fixed height, so a model with more levels never resizes
   it; a short window shrinks it and keeps the footer; below 640px the column goes under the list. */
.bt-model-menu[data-docked]{padding:0;gap:0;overflow:hidden}
.bt-mp{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;font-size:13px;line-height:18px}
.bt-mp-body{display:flex;height:346px;min-height:0;flex:0 1 auto}
.bt-mp-picker{display:flex;flex:1 1 auto;min-width:0;min-height:0}
.bt-mp-rail{flex:none;width:44px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;box-sizing:border-box;overflow-y:auto;scrollbar-width:none;background:var(--bt-tag-bg)}
.bt-model-menu .bt-mp-rail .bt-mp-tab{position:relative;flex:none;width:34px;height:34px;min-height:34px;padding:0;justify-content:center;border-radius:8px;color:var(--bt-ink-2)}
.bt-model-menu .bt-mp-rail .bt-mp-tab svg{width:18px;height:18px;margin:0}
.bt-model-menu .bt-mp-rail .bt-mp-tab[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-model-menu .bt-mp-rail .bt-mp-tab[aria-pressed=true]::after{content:"";position:absolute;right:-5px;top:7px;width:3px;height:20px;border-radius:4px;background:var(--bt-accent)}
.bt-model-menu .bt-mp-rail .bt-mp-tab:disabled{opacity:.42;cursor:default;background:none}
.bt-model-menu .bt-mp-rail .bt-mp-tab[data-model-picker-provider=favorites]{color:var(--bt-ink)}
.bt-mp-rail-sep{flex:none;width:24px;height:1px;margin:2px 0;background:var(--bt-line-2)}
.bt-model-menu .bt-mp-rail .bt-mp-manage{margin-top:auto;color:var(--bt-ink-3)}
.bt-mp-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;border-left:1px solid var(--bt-line)}
.bt-mp-search{flex:none;display:flex;align-items:center;gap:8px;margin:10px 12px 0;height:33px;padding-bottom:6px;border-bottom:1px solid var(--bt-line-2);color:var(--bt-ink-3);box-sizing:border-box}
.bt-mp-search:focus-within{border-bottom-color:var(--bt-accent)}
.bt-mp-search svg{flex:none}
.bt-mp-search input{flex:1;min-width:0;border:0;outline:0;background:none;padding:0;font:inherit;font-size:14px;line-height:20px;color:var(--bt-ink)}
.bt-mp-search input::placeholder{color:var(--bt-ink-3)}
.bt-mp-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 8px 6px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin}
.bt-mp-heading{flex:none;padding:6px 8px 2px;font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3)}
.bt-mp-row{flex:none;display:flex;align-items:center;gap:8px;min-height:32px;padding:0 6px 0 8px;border-radius:6px;cursor:pointer;color:var(--bt-ink);box-sizing:border-box}
.bt-mp-row[data-highlighted]{background:var(--bt-hover)}
.bt-mp-row[data-unavailable]{color:var(--bt-ink-3)}
.bt-mp-row-mark{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;color:var(--bt-ink-2)}
.bt-mp-row-mark svg{width:16px;height:16px}
.bt-mp-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--bt-weight-label,500)}
.bt-mp-row-check{flex:none;display:inline-flex;color:var(--bt-ink-2)}
.bt-mp-row-check svg{width:14px;height:14px}
.bt-mp-row-hint{flex:none;margin-left:auto;font-size:11px;line-height:14px;color:var(--bt-ink-3);white-space:nowrap}
.bt-model-menu .bt-mp-row .bt-mp-star{flex:none;width:24px;height:24px;min-height:24px;padding:0;margin-left:auto;justify-content:center;border-radius:6px;color:var(--bt-ink-3);opacity:0}
.bt-mp-row-hint+.bt-mp-star{margin-left:0}
.bt-model-menu .bt-mp-row .bt-mp-star svg{width:14px;height:14px;margin:0}
.bt-mp-row[data-highlighted] .bt-mp-star,.bt-mp-row:hover .bt-mp-star,.bt-mp-star[data-on],.bt-mp-star:focus-visible{opacity:1}
.bt-model-menu .bt-mp-row .bt-mp-star[data-on]{color:var(--bt-accent)}
.bt-mp-kbd{flex:none;min-width:24px;padding:2px 5px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-ink-3);font:inherit;font-size:11px;line-height:14px;text-align:center;font-variant-numeric:tabular-nums}
.bt-mp-note{flex:none;padding:6px 8px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-mp-empty{flex:none;padding:8px;color:var(--bt-ink-2)}
.bt-model-menu .bt-mp-manage-row{flex:none;margin-top:4px;color:var(--bt-ink-2)}
.bt-mp-effort{flex:none;width:192px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--bt-line);background:var(--bt-tag-bg)}
.bt-mp-effort-head{flex:none;display:flex;align-items:center;gap:8px;margin:10px 12px 0;height:33px;padding-bottom:6px;border-bottom:1px solid var(--bt-line-2);color:var(--bt-ink-2);box-sizing:border-box}
.bt-mp-effort-model{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--bt-ink-3)}
.bt-mp-effort-rows{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 8px 6px;display:flex;flex-direction:column;gap:2px}
.bt-model-menu .bt-mp-level{flex:none;min-height:32px;padding:0 8px;gap:8px}
.bt-mp-level-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-mp-level-check{flex:none;display:inline-flex;color:var(--bt-ink)}
.bt-mp-level-check svg{width:14px;height:14px}
.bt-mp-level-default{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3)}
.bt-mp-effort-none{padding:6px 8px;color:var(--bt-ink-3)}
.bt-mp-foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--bt-line);background:var(--bt-tag-bg)}
.bt-mp-speed{display:flex;padding:2px;border-radius:var(--st-r-seg,8px);background:var(--bt-tag-bg)}
.bt-model-menu .bt-mp-speed .bt-mp-segment{width:auto;min-height:24px;height:24px;padding:0 8px;gap:4px;border-radius:6px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-model-menu .bt-mp-speed .bt-mp-segment[data-checked]{background:var(--bt-card);color:var(--bt-ink);box-shadow:0 0 0 .5px var(--bt-line-2)}
.bt-model-menu .bt-mp-speed .bt-mp-segment:disabled{opacity:.5;cursor:default}
.bt-mp-bolt{display:inline-flex;color:inherit}
.bt-mp-bolt svg,.bt-model-menu .bt-mp-segment .bt-mp-bolt svg{width:13px;height:13px;margin:0}
.bt-model-bar-fast{display:inline-flex;flex:none;color:var(--bt-ink-3)}
.bt-mp-confirm{padding:10px}
.bt-model-menu .bt-mp :is(button,[role=option]):focus-visible{outline:2px solid var(--st-ring,var(--bt-accent));outline-offset:-2px}
.bt-mp-search input:focus-visible{outline:0}
/* Touch screens: rows and controls keep the 44px the other menus give a finger, and the star shows without a hover. */
@media (hover:none){
  .bt-mp-row,.bt-model-menu .bt-mp-level{min-height:44px}
  .bt-model-menu .bt-mp-rail .bt-mp-tab{width:40px;height:40px;min-height:40px}
  .bt-model-menu .bt-mp-row .bt-mp-star{width:36px;height:36px;min-height:36px;opacity:1}
  .bt-model-menu .bt-mp-speed .bt-mp-segment{height:36px;min-height:36px;padding:0 12px}
}
@media (max-width:639px){
  .bt-mp-body{flex-direction:column;height:auto}
  .bt-mp-picker{height:300px;flex:0 1 auto}
  .bt-mp-effort{width:auto;height:200px;border-left:0;border-top:1px solid var(--bt-line)}
  .bt-mp-kbd{display:none}
}
@media (prefers-reduced-motion:reduce){.bt-model-dock{animation:none}.bt-model-step{animation:none}.bt-model-spin{animation-duration:2s}.bt-model-caret{transition:none}.bt-model-tick svg{animation:none}}
`
