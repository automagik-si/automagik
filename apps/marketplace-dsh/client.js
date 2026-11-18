/**
 * Browser half of the Automagik marketplace.
 *
 * Two seats here:
 * - The Apps entry (the Bot team's left bar, or the shell panel list in a plain DSH)
 *   and the main page it opens.
 * - The Bot browser: a right-Sidebar tab type, plus a globe in every Session's header,
 *   that shows the browser the Bot owning that Session is driving (watch-only; the Bot
 *   keeps driving it with its own tools). It works in the Web app, where the panel in a
 *   Bot chat has no Electron webview to draw into.
 */
window.__ModuleLoader__.load({
  id: '@automagik/marketplace-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The panel id, shared by the entry and the main panel it opens. */
    const PANEL_ID = 'apps'
    /** The label the entry and the page carry. */
    const LABEL = 'Apps'
    /** The Bot browser tab type's identity in the right-Sidebar registry. */
    const BROWSER_TAB_ID = '@automagik/marketplace-dsh/browser'
    /** The kind a Session opens for the Bot browser page. */
    const BROWSER_KIND = 'botbrowser'
    /** How often the live view asks the Host for a fresh frame while it is open. */
    const POLL_MS = 1000

    /** The Bot team's own client, when this app has it: the roster and the host call. */
    function botsClient() {
      try {
        const mod = require('@automagik/bots-dsh/client')
        return mod && mod.omni ? mod.omni : null
      } catch {
        return null
      }
    }

    /** The Bot that owns this Session, from the roster, or undefined when none does. */
    function botOfSession(roster, sessionId) {
      if (!roster || sessionId === undefined || sessionId === null || sessionId === '') return undefined
      if (roster.byId && roster.byId[sessionId] !== undefined) return roster.byId[sessionId]
      if (roster.agentOf && roster.agentOf[sessionId] !== undefined) {
        const agent = roster.agentsById ? roster.agentsById[roster.agentOf[sessionId]] : undefined
        if (agent !== undefined) return agent
      }
      const bots = [...(roster.bots ?? []), ...(roster.agents ?? [])]
      return bots.find(bot => bot && (bot.id === sessionId || bot.sessionId === sessionId))
    }

    /** The Apps glyph: a four-tile grid with a plus, in the current text color. */
    function AppsIcon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 2.75, y: 2.75, width: 6, height: 6, rx: 1.6 }),
        h('rect', { x: 11.25, y: 2.75, width: 6, height: 6, rx: 1.6 }),
        h('rect', { x: 2.75, y: 11.25, width: 6, height: 6, rx: 1.6 }),
        h('path', { d: 'M14.25 11.5v5M11.75 14h5' }),
      )
    }

    /** The globe: the Bot browser's own mark, in the header and the guide card. */
    function GlobeIcon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 10, cy: 10, r: 7 }),
        h('path', { d: 'M3 10h14' }),
        h('path', { d: 'M10 3c2 2.2 2.9 4.5 2.9 7s-.9 4.8-2.9 7c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z' }),
      )
    }

    /** The marketplace page; a placeholder until the app list arrives. */
    function AppsPage() {
      return h(
        'div',
        {
          style: {
            boxSizing: 'border-box',
            height: '100%',
            overflowY: 'auto',
            padding: '32px 40px',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            font: 'inherit',
          },
        },
        h('div', { style: { maxWidth: 720, margin: '0 auto' } },
          h('h1', { style: { margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' } }, LABEL),
          h('p', { style: { margin: '8px 0 0', fontSize: 14, color: 'var(--dsw-alias-label-secondary)' } },
            'Every Automagik app in one place: what is included, what you can add, and when something needs an update.'),
          h('div', {
            style: {
              marginTop: 28,
              padding: '18px 20px',
              border: '1px dashed var(--dsw-alias-border-l2)',
              borderRadius: 14,
              fontSize: 13.5,
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          }, 'The catalog is being wired up. This seat is live so the app list, installs and updates can land here next.')),
      )
    }

    /** Read one frame of the Bot's browser, naming the state when there is none. */
    async function loadFrame(botId) {
      const omni = botsClient()
      if (!omni || typeof omni.call !== 'function') return { status: 'no-host' }
      try {
        const frame = await omni.call('browser-frame', { botId })
        return frame && frame.data ? { status: 'frame', frame } : { status: 'no-page' }
      } catch (error) {
        const code = error && error.code
        if (code === 'bot/browser-off') return { status: 'off' }
        if (code === 'bot/not-found') return { status: 'no-page' }
        return { status: 'error', message: String((error && error.message) || error) }
      }
    }

    /** The tab body: names the Bot and the page, then redraws the latest frame. */
    function BotBrowserBody({ sessionId, useRoster }) {
      const roster = useRoster ? useRoster(value => value) : undefined
      const bot = botOfSession(roster, sessionId)
      const botId = bot ? bot.id : undefined
      const [state, setState] = React.useState({ status: botId === undefined ? 'no-bot' : 'loading' })

      React.useEffect(() => {
        let alive = true
        let timer
        if (botId === undefined) {
          setState({ status: 'no-bot' })
          return undefined
        }
        const tick = async () => {
          const next = await loadFrame(botId)
          if (!alive) return
          setState(next)
          timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        return () => { alive = false; clearTimeout(timer) }
      }, [botId])

      if (state.status === 'frame') {
        const { frame } = state
        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#111214' } },
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flex: 'none',
              borderBottom: '.5px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
            },
          },
          h('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary, #16a34a)', flex: 'none' } }),
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: 'none', maxWidth: '38%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (bot && bot.name) || 'This Bot'),
          h('span', { title: frame.url || '', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, frame.title || frame.url || 'A page'),
          h('span', { style: { flex: 'none', fontSize: 10.5, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--dsw-alias-brand-primary, #3b82f6)' } }, 'Live')),
          h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'start center' } },
            h('img', {
              src: `data:${frame.mime || 'image/jpeg'};base64,${frame.data}`,
              alt: `The page ${frame.title || frame.url || ''}`,
              draggable: false,
              style: { display: 'block', width: '100%', height: 'auto' },
            })))
      }
      const note = state.status === 'no-bot'
        ? ['No Bot browser here', 'This Session belongs to no Bot, so it has no browser of its own. Open a Session a Bot owns.']
        : state.status === 'no-host'
          ? ['The Bot team is not mounted', 'This app has no Bot team plugin, so there is no Bot browser to show.']
          : state.status === 'off'
            ? ['Bot browsers are off', 'This host has the Bot browser turned off.']
            : state.status === 'no-page'
              ? ['No page open yet', 'This Bot has not opened a page. Ask it to browse, or wait until it does.']
              : state.status === 'error'
                ? ['Could not read the page', state.message]
                : ['Connecting to the Bot’s browser…', 'The first frame arrives in a moment.']
      return h('div', { style: { padding: '22px 18px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } },
        h('strong', { style: { display: 'block', marginBottom: 4, fontSize: 13.5, color: 'var(--dsw-alias-label-primary)' } }, note[0]),
        h('span', null, note[1]))
    }

    /** The globe in a Session header: opens the Bot browser tab for that Session. */
    function BrowserHeaderButton({ open }) {
      return h('button', {
        type: 'button',
        onClick: open,
        title: 'Bot browser',
        'aria-label': 'Bot browser',
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, padding: 0, border: 0, borderRadius: 8,
          background: 'none', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: 'pointer',
        },
      }, h(GlobeIcon, { size: 16 }))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const open = () => ctx.layout.selectPanel(PANEL_ID)

        // The Automagik app's left bar: one round tool beside Omni/Genie, Search and New.
        const omni = botsClient()
        const tools = omni && omni.sidebarTools ? omni.sidebarTools : null
        if (tools && typeof tools.register === 'function') {
          ctx.effect(() => tools.register({
            id: 'automagik-marketplace',
            order: -20,
            Component: () => h(
              'button',
              {
                type: 'button',
                className: 'bt-round bt-side-tool bt-apps',
                'aria-label': LABEL,
                title: LABEL,
                onClick: open,
              },
              h(AppsIcon, { size: 18 }),
            ),
          }), 'automagik-marketplace: apps tool')
        }

        // A plain DSH profile: the shell sidebar's own panel list.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: -10,
          label: () => LABEL,
        }, AppsIcon))

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, AppsPage))

        // The Bot browser beside any Session a Bot owns, in DSH's own right pane, with a
        // globe in every Session header. Watch-only: the Bot keeps driving the page.
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: BROWSER_TAB_ID,
            kind: BROWSER_KIND,
            title: () => 'Browser',
            guide: [{
              id: 'new',
              order: 30,
              title: () => 'Bot browser',
              description: () => 'Watch the browser this Bot is driving, live.',
              icon: GlobeIcon,
            }],
          }), 'automagik-marketplace: bot browser tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: BROWSER_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, BotBrowserBody)), 'automagik-marketplace: bot browser body')
          scope.effect(() => scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
            name: 'conversation.session.header.actions',
            id: 'bot-browser-open',
            order: -50,
            label: () => 'Bot browser',
            inject: (sessionId) => ({ open: () => scope.sidebarRight.openTabIn(sessionId, BROWSER_KIND) }),
          }, BrowserHeaderButton)), 'automagik-marketplace: bot browser header button')
        })
      },
    }
  },
})
