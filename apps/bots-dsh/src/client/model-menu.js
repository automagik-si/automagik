import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { currentPart } from './text.js'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ConnectorIcon, SlidersIcon } from './icons.js'
import { BotMark } from './mark.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { SPRING_POP, SPRING_SHAPE, spring, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { HostModelMenu } from './host-model-menu.js'
import { AgentMark, DshMarkIcon, HerdrMarkIcon } from './marks.js'
import { crossesHarness, routeOf, selectorRouteOf } from '../shared/routes.js'
import { HermesMark, HERMES_MARK_CSS } from './hermes-mark.js'
import { HermesRemoteConnect } from './hermes-remote.js'

const MENU_EXIT_MS = 120

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
const labelOf = (roster, ref) => (typeof ref === 'string' ? servedOf(roster, ref)?.name ?? (ref.split('/').slice(1).join('/') || ref) : t('the new model'))
export function modelStateLine(state, roster) {
  if (state === undefined || state === null) return undefined
  const failure = state.lastFailure
  if (failure?.kept) {
    const params = { model: labelOf(roster, failure.ref), kept: labelOf(roster, failure.kept) }
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
  // A Bot whose model its plugin owns: the DSH model saved on it answers nothing. The hint
  // names what answers now, from the plugin's menu, or says nothing.
  const host = roster.hostModels?.[bot.id]
  if (host !== undefined) {
    const answering = host.entries?.find(entry => entry.answering)?.label
    return answering ? t('{model} answers now.', { model: answering }) : null
  }
  const shown = modelOf(bot, roster)
  if (shown === undefined) return t('Pick the model this Bot runs on.')
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
export const ACP_NAME = Object.freeze({
  'acp-claude': 'Claude Code', 'acp-codex': 'Codex', 'acp-hermes': 'Hermes',
  'acp-antigravity': 'Antigravity', 'acp-omp': 'omp',
})
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

// The rows a step shows (model-menu cascade). The first step is the route, then (ACP and
// Herdr) the agent, then the route's and agent's models, then a model's thinking levels.
// `current` is the Bot's model, `picked` its level when that model serves it, `levelName`
// that level's name. `go(view)` opens another step; `onModel(model, route)` and
// `onLevel(model, effort)` pick; the menu offers the provider's API key where it can.
export function ModelSteps({ roster, bot, view, current, picked, levelName, go, onModel, onLevel, onManage, onRemote }) {
  const models = roster.models ?? []
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
    return h('div', { key: `models:${route}:${view.provider ?? view.agent ?? ''}`, className: 'bt-model-step', role: 'group', 'aria-label': t('Models') },
      stepBack(backLabel, () => go(back.view)),
      route === 'hermes-remote' ? h('div', { className: 'bt-model-none' }, t("Your bots’ team tools (messages to other bots, secrets, memory, schedules) are not available in these chats.")) : null,
      route === 'hermes-remote' && list.length === 0 ? h('div', { className: 'bt-model-none' }, t('Off by default. Set up Remote Hermes in Bot settings.')) : null,
      h('div', { className: 'bt-menu-sep', role: 'separator' }),
      groups.length === 0 ? h('div', { className: 'bt-model-none' }, t('No models are set up for this route yet.')) : null,
      groups.map(([label, entries]) => h(Fragment, { key: label },
        h('div', { className: 'bt-model-group', role: 'presentation' }, label),
        entries.map((entry) => {
          const herdr = route === 'herdr'
          const pending = entry.pending === true
          const off = herdr || pending || offModel(entry)
          const why = herdr || pending ? t('Not available yet') : modelUnavailableText(entry)
          const name = herdr ? herdrModelLabel(entry) : modelLabel(entry)
          const more = !off && effortRows(knownEfforts(entry)).length > 0
          return h('button', {
            key: entry.ref ?? entry.id, type: 'button', role: 'menuitemradio', 'aria-checked': !herdr && !pending && entry.ref === current,
            title: entry.ref, 'aria-haspopup': more ? 'menu' : undefined,
            'data-unavailable': off ? '' : undefined,
            'aria-label': why ? `${name} · ${why}` : undefined,
            onClick: () => onModel(entry, route),
          },
          h('span', { className: 'bt-menu-label' }, name),
          why ? h('span', { className: 'bt-menu-hint' }, why)
            : entry.ref === roster.defaultModel ? h('span', { className: 'bt-menu-hint' }, t('Default')) : null,
          h(Tick, { on: !herdr && !pending && entry.ref === current }),
          more ? h(ChevronRightIcon) : null)
        }))))
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
        const why = herdr || pending ? t('Not available yet') : signedOut ? t('Needs a sign-in') : undefined
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
      const remembered = roster.prefs?.hermesRemote
      const rememberedProfile = remembered?.enabled ? remembered.profile : undefined
      const now = route === 'hermes-remote' && onRemote
        ? rememberedProfile || t('Set up')
        : here
        ? [modelRoute(roster, current).connection, levelName].filter(Boolean).join(' · ')
        : route === 'herdr' ? t('Not available yet') : undefined
      return h('button', {
        key: route, type: 'button', role: 'menuitem', 'aria-haspopup': route === 'hermes-remote' && onRemote ? 'dialog' : 'menu', 'data-current': here ? '' : undefined,
        'data-route': route, 'data-unavailable': route === 'herdr' ? '' : undefined,
        title: route === 'acp' ? t('Agent Client Protocol') : route === 'herdr' ? t('Not available yet') : undefined,
        'aria-label': here ? t('{route}, current model {model}', { route: routeName(route), model: now ?? '' })
          : now ? `${routeName(route)} · ${now}` : `${routeName(route)} · ${routeDetail(route)}`,
        onClick: () => route === 'hermes-remote' && onRemote ? onRemote() : go(route === 'native' || route === 'hermes-remote' ? { step: 'models', route } : { step: 'agents', route }),
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
export function useAnchoredMenu({ onEscape, minWidth = 240 } = {}) {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const escape = useRef(onEscape)
  escape.current = onEscape
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (escape.current?.() === true) return
      close()
      button.current?.focus()
    }
    const onScroll = (event) => { if (!menu.current?.contains(event.target)) close() }
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
    const width = Math.max(minWidth, rect.width)
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
// A Bot whose model menu its plugin owns gets that menu instead (host-model-menu.js).
export function ModelMenu(props) {
  return h(props.roster?.hostModels?.[props.bot?.id] === undefined ? DshModelMenu : HostModelMenu, props)
}

// The word before a crossing: the route (or the agent inside ACP) changes, which starts a
// new conversation with a handoff note (RFC 0030, Decided 6 and 10). Nothing is applied
// until the person confirms here.
export function RouteConfirm({ bot, roster, current, target, onCancel, onConfirm }) {
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
  return h('div', { className: 'bt-model-step bt-model-confirm', role: 'group', 'aria-label': t('Start a new conversation?') },
    h('div', { className: 'bt-model-confirm-title' }, t('Start a new conversation?')),
    h('div', { className: 'bt-model-confirm-move' },
      from ? `${routeName(from.route)} · ${from.connection} → ` : '',
      `${routeName(to.route)} · ${to.connection}`),
    h('div', { className: 'bt-model-confirm-text' }, routeChanged
      ? t('Changing the route starts a new conversation. {name} writes a handoff note first.', { name: bot.name })
      : t('Changing the agent starts a new conversation. {name} writes a handoff note first.', { name: bot.name })),
    fullAccessLine === undefined ? null : h('div', { className: 'bt-model-confirm-access', role: 'note' }, fullAccessLine),
    h('div', { className: 'bt-model-confirm-actions' },
      h('button', { type: 'button', className: 'bt-model-confirm-cancel', onClick: onCancel }, t('Keep this conversation')),
      h('button', { type: 'button', className: 'bt-model-confirm-go', onClick: onConfirm }, routeChanged ? t('Change route') : t('Change agent'))))
}

function DshModelMenu({ bot, roster, actions, run, wide = false, link = false, chat = false, bar = false, onPick, onPickEffort, saved = onPick === undefined }) {
  const [view, setView] = useState(MENU_ROOT)
  const [hermes, setHermes] = useState(false)
  const remote = useRef({ generation: 0, active: false, mounted: true })
  const owner = useRef(bot.id)
  owner.current = bot.id
  useEffect(() => {
    remote.current.mounted = true
    return () => { remote.current.mounted = false; remote.current.active = false; remote.current.generation++ }
  }, [])
  // A route change waits for the person's word here, because it starts a new conversation.
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
    if (view.step === 'routes') return false
    keys.current = true
    if (view.step === 'levels') setView({ step: 'models', route: view.route, ...(view.provider ? { provider: view.provider } : {}) })
    else if (view.step === 'models' && routeOfView() !== 'native') setView({ step: 'agents', route: routeOfView() })
    else setView(MENU_ROOT)
    return true
  }
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({ onEscape: back, minWidth: 300 })
  const live = useRef(false)
  live.current = isOpen
  const shown = modelOf(bot, roster)
  const current = bot.model ?? bot.appliedModel
  const currentRoute = current === undefined ? undefined : modelRoute(roster, current)
  const served = servedOf(roster, current)
  const reasoning = useEfforts(served, current, actions)
  // The level the Bot runs on: its pick when the model serves it, else the model's own.
  const picked = reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  const currentEffort = picked ?? reasoning?.defaultEffort
  const effortLabel = currentEffort === undefined
    ? (reasoning?.efforts?.length > 0 ? t('Default') : undefined)
    : reasoning.efforts.find(effort => effort.id === currentEffort)?.name ?? currentEffort
  // A route's models whose levels the catalog does not carry are asked for as it opens,
  // so each row can say whether a level step follows.
  useEffect(() => {
    if (!isOpen || view.step !== 'models') return undefined
    let on = true
    const route = view.route ?? routeOfProvider(view.provider)
    const list = route === 'native' ? nativeModels(roster.models, current)
      : route === 'acp' ? (acpAgents(roster.models).find(agent => agent.provider === view.provider)?.models ?? [])
        : []
    const unknown = list.filter(model => model.ref !== undefined && !offModel(model) && knownEfforts(model) === undefined)
    for (const model of unknown) void askEfforts(model.ref, actions).then(() => { if (on) setAsked(count => count + 1) })
    return () => { on = false }
  }, [isOpen, view, roster.models, current])
  // The step that opens takes the focus when the menu is used from the keyboard (or a row was
  // clicked): its current row, else its first.
  useEffect(() => {
    const node = menu.current
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
    setConfirm(undefined)
    setKeyFor(undefined)
    // DSH settings can change the list at any time, so opening asks again.
    void actions?.refreshModels?.()
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
  const pickModel = (ref, effort, { routeChange = false, level = false } = {}) => {
    // A crossing started from a saved Bot's settings still goes through the picker's own
    // action: the settings wrapper needs to keep its sign-in/account handling.
    if (routeChange && typeof onPick === 'function') return onPick(ref, { routeChange: true, effort })
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
      // The host moves the Bot to a fresh part with a handoff note (parts.js), so the pane
      // shows a new conversation and nothing of the old harness crosses silently.
      const pick = chat && actions.switchRouteInChat ? actions.switchRouteInChat : actions.switchRoute
      if (typeof pick === 'function') return run(pick(bot.id, ref, level || effort !== undefined ? { effort: effort ?? null } : {}))
    }
    // In a Bot's chat a signed-out agent opens the sign-in row there (cli-login.js, rule 2).
    if (chat && actions.chooseModelInChat) return run(actions.chooseModelInChat(bot.id, ref, level || effort !== undefined ? { effort: effort ?? null } : {}))
    return run(actions.updateBot(bot.id, { model: ref, ...(level || effort !== undefined ? { effort: effort ?? null } : {}) }))
  }
  const commit = (model, effort) => {
    if (model.ref !== undefined && crossing(model.ref)) { setConfirm({ ref: model.ref, effort }); return }
    finish()
    void Promise.resolve(pickModel(model.ref, effort)).catch(() => {})
  }
  // A model with levels opens its level step; one without applies now. Levels not known yet
  // are asked for first. A model that needs an API key asks for it, a signed-out agent opens
  // its sign-in row in the chat, and Herdr's models wait for #1007.
  const onModel = (model, route) => {
    if (route === 'herdr' || model.ref === undefined) return
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
    if (crossing(model.ref)) { setConfirm({ ref: model.ref, effort }); return }
    finish()
    void Promise.resolve(pickModel(model.ref, effort, { level: true })).catch(() => {})
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
    bot, roster, current, target: confirm, onCancel: () => setConfirm(undefined),
    onConfirm: () => { const next = confirm; setConfirm(undefined); finish(); void Promise.resolve(pickModel(next.ref, next.effort, { routeChange: true })).catch(() => {}) },
  })
  const openRemote = () => {
    const generation = ++remote.current.generation
    remote.current.active = true
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
    if (crossing(next.modelRef)) {
      keys.current = true
      setView(MENU_ROOT)
      setConfirm({ ref: next.modelRef, effort: undefined })
      open()
    } else {
      finish()
      void Promise.resolve(pickModel(next.modelRef, undefined)).catch(() => {})
    }
  }
  return h(Fragment, null,
    hermes ? h(HermesRemoteConnect, { key: hermes, onClose: () => closeRemote(hermes), onConnected: next => remoteConnected(next, hermes) }) : null,
    link ? h('button', {
      ref: button, type: 'button', className: 'bt-model-change', 'aria-haspopup': 'menu', 'aria-expanded': isOpen,
      'aria-label': t('Change the model of {name}', { name: bot.name }), onClick: toggle,
    }, t('change')) : h('button', {
      ref: button, type: 'button', className: `bt-model-trigger${bar ? ' bt-model-bar-trigger' : ''}`, 'data-wide': wide || undefined,
      'data-bar': bar || undefined, 'data-route': currentRoute?.route, 'aria-haspopup': 'menu', 'aria-expanded': isOpen,
      'aria-label': t('Model: {model}', { model: shown?.name ?? t('none') }),
      'data-missing': shown !== undefined && shown.unavailable && models.length > 0 ? '' : undefined, onClick: toggle,
    },
    bar
      ? h('span', { className: 'bt-model-bar' },
        currentRoute === undefined ? null : h('span', { className: 'bt-model-bar-route', 'aria-hidden': true }, h(ROUTE_ICON[currentRoute.route] ?? ConnectorIcon, { size: 14 })),
        h('span', { className: 'bt-model-bar-name' }, shown?.name ?? t('Choose a model')),
        effortLabel === undefined ? null : h('span', { className: 'bt-model-bar-effort' }, effortLabel))
      : h('span', { className: 'bt-model-copy' },
        h('span', { className: 'bt-model-name' }, shown?.name ?? t('Choose a model')),
        second === null ? null : h('span', { className: 'bt-model-provider' }, second)),
    h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': t('Model for {name}', { name: bot.name }), style: shownPlace, 'data-leaving': leaving || undefined, onKeyDown },
      confirmView ?? h(ModelSteps, {
        roster, bot, view, current, picked, levelName: effortLabel, go, onModel, onLevel,
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
  // A Bot whose model its plugin picks never waits for a DSH model.
  const hosted = roster.hostModels?.[bot?.id] !== undefined
  const shown = Boolean(bot) && currentPart(bot) === sessionId && roster.ready && !hosted && !idle
  useEffect(() => { if (shown) void actions.refreshModels?.() }, [shown, sessionId])
  if (!shown) return null
  const models = roster.models ?? []
  // A model whose provider has no API key or sign-in fails every turn, so it is no choice;
  // nor is one another connection already offers, nor one on a route this bot type hides.
  const routes = routesFor(bot, roster)
  const usable = models.filter(usableModel).filter(model => routes.includes(modelRoute(roster, model.ref).route))
  const lost = bot.model ? !models.some(model => model.ref === bot.model) : false
  const run = promise => Promise.resolve(promise).then(() => { setError(''); return true }, (failure) => { setError(failure?.message ?? String(failure)); return false })
  // An unknown catalog (none listed) cannot tell a lost model from a slow provider.
  if (bot.model && (!lost || models.length === 0)) return null
  // A window without DSH's own settings takes the missing key here.
  const keyFor = usable.length === 0 && actions.setProviderKey ? models.find(model => model.needsKey) : undefined
  const manage = manageModels(actions)
  // Settles true once the model is saved, so a level picked with it follows (ModelMenu).
  const pick = (ref) => {
    setBusy(ref)
    setError('')
    return Promise.resolve(actions.chooseModelInChat ? actions.chooseModelInChat(bot.id, ref) : actions.updateBot(bot.id, { model: ref }))
      .then(() => true, (failure) => { setError(failure?.message ?? String(failure)); void actions.refreshModels?.(); return false })
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
      : h('div', { className: 'bt-model-chips', role: 'group', 'aria-label': t('Choose a model') }, choices),
    error ? h('div', { className: 'bt-secret-error bt-model-error', role: 'alert' }, error) : null)
}

// The provider's API key, saved through the host; once it is set, the provider's
// models become the choices.
function ModelKeyCard({ model, actions }) {
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
      .then(() => setValue(''), failure => setError(hostText(failure?.message ?? String(failure))))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-q bt-model-key', role: 'group', 'aria-label': label },
    h('div', { className: 'bt-model-key-title' }, h(KeyIcon), label),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label, autoFocus: true })),
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      actions.openModels ? h('button', { type: 'button', className: 'bt-q-btn bt-model-key-other', onClick: actions.openModels }, t('Another provider')) : null,
      h('button', { type: 'button', className: 'bt-q-submit', disabled: !ready, onClick: save }, busy ? t('Saving…') : t('Save'))))
}

// Where the providers are set up: the window's own Models page, else DSH's settings.
const manageModels = actions => actions.openModels ?? actions.openHarnessSettings

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
.bt-model-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 0 10px;box-sizing:border-box;animation:bt-model-in ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
/* After the last turn of a transcript the card is one more message: the column's width, and
   the room a message has above it. */
.bt-model-seat{margin:6px 0 4px}
.bt-model-seat>.bt-model-dock{max-width:none;margin:0;padding:0}
.bt-model-chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:30px;max-width:min(560px,calc(100% - 30px));max-height:min(240px,36vh);max-height:min(240px,36dvh);overflow-y:auto;scrollbar-width:thin}
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
@media (prefers-reduced-motion:reduce){.bt-model-dock{animation:none}.bt-model-step{animation:none}.bt-model-spin{animation-duration:2s}.bt-model-caret{transition:none}.bt-model-tick svg{animation:none}}
`
