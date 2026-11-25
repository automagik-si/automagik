import { createElement as h, useSyncExternalStore } from 'react'
import {
  allThemes, BotMark, BrandMark, BrandName, call, checkViewer, CONVERSATION_CSS, createSource, dayLabel, freePriority,
  catalogueLookOf, installCompiledStyles, installStyles, isRetired, LEFT_BAR_CSS, mountedViewer, Nothing, onRetire,
  requestViewer, SHELL_CSS, Shimmer, SIDEBAR_CSS, t, themeCss,
} from './gated-shared.js'
import { ACP_NAME } from '../shared/routes.js'
import { applyPage, botLabels, changedBot, feedEnded, initialMember, isCurrent, pageRows, requestView, selectBot, updateRoster } from './member-model.js'

const mark = bot => h(BotMark, { bot, look: { ...catalogueLookOf(bot), pet: undefined }, live: false, size: 28 })
const plain = text => (text ?? '').split('\n').flatMap((line, index) => index === 0 ? [line] : [h('br', { key: index }), line])

export function MemberRows({ pages, roster, botId }) {
  const bot = Object.hasOwn(roster.byId, botId) ? roster.byId[botId] : undefined
  return pageRows(pages).map(({ row, key }) => {
    if (row.kind === 'divider') {
      // Where an agent switch moved the chat (RFC 0030, Handoff note): the agent by the menu's
      // own name for it, else its ref; never translated.
      const switched = typeof row.switchedTo === 'string' && row.switchedTo !== ''
        ? t('Switched to {agent}', { agent: ACP_NAME[row.switchedTo.split('/')[0]] ?? row.switchedTo }) : undefined
      const day = Number.isFinite(row.time) ? dayLabel(row.time) : undefined
      return h('div', { key, className: 'bt-part-line', role: 'separator' },
        switched === undefined && day === undefined ? null : h('span', null, [switched, day].filter(part => part !== undefined).join(' · ')))
    }
    if (row.kind === 'user') {
      return h('div', { key, className: 'bt-urow' }, h('div', { className: 'bt-ububble' }, plain(row.text),
        row.images ? h('span', { className: 'bt-uimages' }, row.images === 1 ? t('1 image') : t('{count} images', { count: row.images })) : null))
    }
    if (row.kind === 'bot') {
      return h('div', { key, className: 'bt-msg-line' }, bot ? mark(bot) : null,
        h('div', { className: 'bt-bubble' }, plain(row.text)))
    }
    return null
  })
}

function MemberRoot({ source, load }) {
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const bot = view.botId !== null && Object.hasOwn(view.byId, view.botId) ? view.byId[view.botId] : undefined
  return h('main', { className: 'bt-earlier', style: { height: '100%', overflowY: 'auto' } },
    bot ? h('header', { className: 'bt-msg-line' }, mark(bot), h('strong', null, bot.name)) : null,
    h('div', { className: 'bt-earlier-top' }, view.loading ? h(Shimmer, null, t('Loading earlier messages…'))
      : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Couldn’t load earlier messages · Retry'))
        : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Load earlier')) : null),
    h(MemberRows, { pages: view.pages, roster: view, botId: view.botId }),
    view.withdrawn ? h('p', { className: 'bt-set-hint' }, t('This Bot is no longer shared with you.'))
      : bot && !view.loading && !view.failed && !view.pages.some(items => items.length > 0)
        ? h('p', { className: 'bt-set-hint' }, t('Nothing to read here yet.')) : null,
    h('p', { className: 'bt-set-hint' }, t('You can read this chat, but not send messages.')))
}

function MemberSidebar({ source, select }) {
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const labels = botLabels(view.bots)
  return h('div', { className: 'bt-side' }, view.bots.length === 0
    ? h('p', { className: 'bt-set-hint' }, t('No Bots are shared with you yet.'))
    : view.bots.map(bot => h('button', {
      key: bot.id, type: 'button', className: 'bt-soft', 'aria-pressed': view.botId === bot.id,
      onClick: () => select(bot.id),
    }, mark(bot), labels.get(bot.id))))
}

export function applyMember(ctx) {
  const source = createSource(initialMember)
  let stopped = false
  let connected = false
  let needsChat = false
  let selection = null
  let feed, retry, pageRequest, rosterRequest
  const current = source.getSnapshot
  const active = () => !stopped && !isRetired()
  const accepts = request => active() && connected && isCurrent(current(), request)
  const cancelReads = () => {
    pageRequest?.abort()
    rosterRequest?.abort()
    pageRequest = rosterRequest = undefined
  }
  const clear = () => {
    cancelReads()
    selection = current().botId ?? selection
    source.set(feedEnded)
  }
  function load(cursor) {
    const request = requestView(current())
    if (!accepts(request) || request.botId === null) return
    if (cursor && pageRequest) return
    pageRequest?.abort()
    const pending = pageRequest = new AbortController()
    source.set(view => ({ ...view, loading: true, failed: false }))
    void call(cursor ? 'earlier' : 'chat', { botId: request.botId, ...(cursor ? { cursor } : {}) }, pending.signal).then(page => {
      if (accepts(request) && pageRequest === pending) source.set(view => applyPage(view, request, page, Boolean(cursor)))
    }, error => {
      if (!accepts(request) || pageRequest !== pending) return
      if (error?.code === 'bot/not-found') {
        clear()
        selection = null
        source.set(view => selectBot(view, null, true))
        refresh()
      } else source.set(view => ({ ...view, loading: false, failed: true, cursor: cursor ?? null }))
    }).finally(() => { if (pageRequest === pending) pageRequest = undefined })
  }
  function refresh({ chat = false } = {}) {
    if (!active() || !connected) return
    needsChat ||= chat
    rosterRequest?.abort()
    const request = requestView(current())
    const pending = rosterRequest = new AbortController()
    void call('state', undefined, pending.signal).then(answer => {
      if (!accepts(request) || rosterRequest !== pending) return
      const next = updateRoster({ ...current(), botId: selection ?? current().botId }, Array.isArray(answer.bots) ? answer.bots : [])
      selection = null
      if (!isCurrent(next, request)) {
        pageRequest?.abort()
        pageRequest = undefined
      }
      source.set(next)
      if (needsChat || next.botId !== request.botId) load()
      needsChat = false
    }, () => {
      if (accepts(request) && rosterRequest === pending) clear()
    }).finally(() => { if (rosterRequest === pending) rosterRequest = undefined })
  }
  function select(id) {
    if (!active() || current().botId === id || !Object.hasOwn(current().byId, id)) return
    const refreshing = rosterRequest !== undefined
    cancelReads()
    source.set(view => selectBot(view, id))
    if (refreshing) refresh({ chat: true })
    else load()
  }
  function connect() {
    if (!active()) return
    let mounted
    try { mounted = requestViewer('feed') } catch { return }
    const viewer = mountedViewer()
    const stream = feed = new EventSource(`api/omni-ui/feed?viewer=${viewer.id}.${viewer.role}`)
    const live = () => {
      try { checkViewer(mounted) } catch { return false }
      return active() && feed === stream
    }
    stream.addEventListener('hello', () => {
      if (!live()) return
      connected = true
      refresh({ chat: true })
    })
    stream.addEventListener('revision', () => { if (live()) refresh() })
    stream.addEventListener('changed', event => {
      if (!live() || !connected) return
      const request = requestView(current())
      let id
      try { id = JSON.parse(event.data)?.botId } catch { return }
      if (changedBot(current(), request, id)) load()
    })
    stream.addEventListener('error', () => {
      if (!live()) return
      connected = false
      clear()
      if (stream.readyState === EventSource.CLOSED) {
        stream.close()
        feed = undefined
        retry = setTimeout(connect, 10_000)
      }
    })
  }
  const stop = () => {
    stopped = true
    feed?.close()
    clearTimeout(retry)
    clear()
    selection = null
    source.set(initialMember)
  }
  ctx.effect(() => {
    const off = onRetire(stop)
    connect()
    return () => { off(); stop() }
  }, 'ds-bot: shared chats')
  ctx.effect(() => installCompiledStyles(
    SHELL_CSS + SIDEBAR_CSS + LEFT_BAR_CSS + CONVERSATION_CSS, 'shared-chats'), 'ds-bot: shared chat styles')
  ctx.effect(() => {
    const style = installStyles(themeCss(allThemes().deepseek), 'shared-chat-theme')
    return () => style.remove()
  }, 'ds-bot: shared chat theme')
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name, ...options, priority: freePriority(ctx.slots.entries(name), { priority: -100, ...options }),
  }, component))
  ctx.effect(() => shadow('main', { key: 'conversation', inject: () => ({ source, load }) }, MemberRoot), 'ds-bot: shared chat')
  ctx.effect(() => shadow('sidebar.workspaces', { inject: () => ({ source, select }) }, MemberSidebar), 'ds-bot: shared Bots')
  for (const name of ['settings.trigger', 'settings.launcher']) {
    ctx.effect(() => shadow(name, {}, Nothing), 'ds-bot: hide ' + name)
  }
  ctx.effect(() => shadow('sidebar.brand.mark', {}, BrandMark), 'ds-bot: brand mark')
  ctx.effect(() => shadow('sidebar.brand.name', {}, BrandName), 'ds-bot: brand name')
  ctx.effect(() => {
    const info = ctx.layout.panelInfo
    const reset = () => { if (info.getSnapshot().activePanelId != null) ctx.layout.selectPanel(null) }
    const off = info.subscribe(reset)
    reset()
    return off
  }, 'ds-bot: keep shared chat selected')
}
