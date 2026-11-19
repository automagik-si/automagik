// The K2 backfill card, mocked with sample data. This page has no network code: nothing here
// calls `fetch`, an XMLHttpRequest or an Omni route. It settles the three states a person sees
// before the card ships: a proposal to choose chats and dates, the approval going out, and the
// live runs with a stop. The card's classes and tokens are the kit's own (GENUI_CSS).
(() => {
  const params = new URLSearchParams(window.location.search)
  const gate = document.getElementById('gate')
  const mock = document.getElementById('mock')
  if (params.get('mock') !== 'backfill') {
    gate.hidden = false
    return
  }
  mock.hidden = false

  const esc = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
  const sample = {
    from: '2026-03-01',
    to: '2026-11-15',
    range: 'Mar 1, 2026 – Nov 15, 2026',
    chats: [
      { id: 'ana', name: 'Ana', channel: 'Shop line', ticked: true },
      { id: 'bruno', name: 'Bruno', channel: 'Shop line', ticked: false },
      { id: 'carla', name: 'Carla', channel: 'Support line', ticked: true },
      { id: 'davi', name: 'Davi', channel: 'Support line', ticked: true },
    ],
  }
  const state = {
    phase: 'proposal',
    approval: 'sending',
    chats: sample.chats.map(chat => ({ ...chat })),
    run: undefined,
    ticks: 0,
    demo: false,
    timer: undefined,
    flipTimer: undefined,
    firstTimer: undefined,
    message: 'A proposal is waiting: nothing is running.',
  }
  const selected = () => state.chats.filter(chat => chat.ticked).map(chat => chat.id)
  const dates = () => ({
    from: document.querySelector('#proposal-card [data-date=from]')?.value ?? sample.from,
    to: document.querySelector('#proposal-card [data-date=to]')?.value ?? sample.to,
  })
  const canStart = () => {
    const { from, to } = dates()
    return selected().length > 0 && from !== '' && to !== '' && from <= to
  }
  const dataState = row => (row.outcome === 'done' ? 'done'
    : row.outcome === 'failed' ? 'failed'
      : row.outcome === 'stopped' ? 'stopped' : 'work')
  const wordOf = row => (row.outcome === 'done' ? 'Done'
    : row.outcome === 'failed' ? 'Failed'
      : row.outcome === 'stopped' ? 'Stopped'
        : row.state === 'queued' ? 'Waiting' : 'Fetching')
  const summaryOf = rows => {
    const count = outcome => rows.filter(row => row.outcome === outcome).length
    return [
      rows.filter(row => row.outcome === null).length ? `${rows.filter(row => row.outcome === null).length} running` : '',
      count('done') ? `${count('done')} done` : '',
      count('stopped') ? `${count('stopped')} stopped` : '',
      count('failed') ? `${count('failed')} failed` : '',
    ].filter(Boolean).join(' · ')
  }
  const number = value => Number(value).toLocaleString('en-US')
  const started = 'Started Nov 18, 2026'

  function proposalHtml() {
    const ticked = state.chats.filter(chat => chat.ticked)
    const { from, to } = state.from === undefined ? { from: sample.from, to: sample.to } : { from: state.from, to: state.to }
    const backwards = from !== '' && to !== '' && from > to
    return `
      <section class="bt-q bt-genui-backfill">
        <div class="bt-q-head">
          <div class="bt-q-text">
            <p class="bt-q-title">Read chat history</p>
            <div class="bt-q-detail">${esc(sample.range)}</div>
          </div>
          <button type="button" class="bt-genui-start" ${canStart() ? '' : 'disabled'}>Start</button>
        </div>
        <p class="bt-genui-note">Choose the chats to read, then set the dates. Nothing starts until you press Start.</p>
        <div class="bt-genui-dates">
          <label class="bt-genui-date-label">Start date
            <input class="bt-genui-date" type="date" data-date="from" aria-label="Start date" value="${esc(from)}">
          </label>
          <label class="bt-genui-date-label">End date
            <input class="bt-genui-date" type="date" data-date="to" aria-label="End date" value="${esc(to)}">
          </label>
        </div>
        <ul class="bt-genui-picks" aria-label="Chats to read">
          ${state.chats.map(chat => `
            <li class="bt-genui-pick">
              <label class="bt-genui-pick-label">
                <input type="checkbox" data-chat="${esc(chat.id)}" ${chat.ticked ? 'checked' : ''}>
                <span class="bt-genui-name">${esc(chat.name)}</span>
                <span class="bt-genui-muted">${esc(chat.channel)}</span>
              </label>
            </li>`).join('')}
        </ul>
        <div class="bt-genui-foot">
          <span class="bt-genui-muted">${number(ticked.length)} chats selected</span>
          ${backwards ? '<span class="bt-genui-error">The start date must be before the end date.</span>' : ''}
        </div>
      </section>`
  }

  function approvalHtml() {
    const sent = state.approval === 'sent'
    return `
      <section class="bt-q bt-genui-backfill" aria-busy="true">
        <div class="bt-q-head">
          <div class="bt-q-text">
            <p class="bt-q-title">Backfill</p>
            <div class="bt-q-detail">${sent
              ? 'Your approval was sent. One backfill is starting for each chat you chose.'
              : 'Sending your approval…'}</div>
          </div>
        </div>
        <div class="bt-genui-foot"><span class="bt-genui-muted">Starting…</span></div>
      </section>`
  }

  function rowHtml(row) {
    const parts = []
    if (row.fetched !== undefined) parts.push(`<span class="bt-genui-num">${number(row.fetched)} fetched</span>`)
    if (row.span) parts.push(`<span class="bt-genui-num bt-genui-span">${esc(row.span)}</span>`)
    const sub = [row.media, row.marks].filter(Boolean).map(text => `<span>${esc(text)}</span>`).join('')
    return `
      <li class="bt-genui-row" data-state="${dataState(row)}">
        <span class="bt-genui-dot" aria-hidden="true"></span>
        <div class="bt-genui-body">
          <div class="bt-genui-line">
            <span class="bt-genui-name">${esc(row.name)}</span>
            <span class="bt-genui-word">${wordOf(row)}</span>
            ${parts.join('')}
          </div>
          ${sub === '' ? '' : `<div class="bt-genui-line bt-genui-sub">${sub}</div>`}
        </div>
        ${row.outcome === null
          ? `<div class="bt-genui-action"><button type="button" class="bt-genui-cancel" data-stop="${esc(row.id)}" aria-label="Stop the backfill of ${esc(row.name)}">Stop</button></div>`
          : ''}
      </li>`
  }

  function runsHtml() {
    if (state.run === undefined) return '<p class="mock-empty">No runs yet. Press Start on the proposal to queue one.</p>'
    return `
      <section class="bt-q bt-genui-backfill-runs">
        <div class="bt-q-head">
          <div class="bt-q-text"><p class="bt-q-title">Backfills</p></div>
        </div>
        <div class="bt-genui-run">
          <div class="bt-genui-run-head">
            <span class="bt-genui-run-range">${esc(sample.range)}</span>
            <span class="bt-genui-num">${number(state.run.rows.length)} chats</span>
            <span class="bt-genui-word">${esc(summaryOf(state.run.rows))}</span>
            <span class="bt-genui-muted">${started}</span>
          </div>
          <ul class="bt-genui-rows" aria-label="${esc(sample.range)}">
            ${state.run.rows.map(rowHtml).join('')}
          </ul>
        </div>
      </section>`
  }

  function render() {
    const proposal = document.getElementById('proposal-card')
    const runs = document.getElementById('runs-card')
    if (state.phase === 'runs') {
      proposal.innerHTML = '<p class="mock-empty">The proposal is used: one approval queued one backfill per ticked chat. The rows are live below.</p>'
    } else {
      proposal.innerHTML = state.phase === 'starting' ? approvalHtml() : proposalHtml()
    }
    runs.innerHTML = runsHtml()
    document.getElementById('live').textContent = state.message
    for (const tab of document.querySelectorAll('[data-phase]')) {
      tab.setAttribute('aria-selected', tab.dataset.phase === state.phase ? 'true' : 'false')
    }
    bind()
  }

  function updateControls() {
    const button = document.querySelector('#proposal-card .bt-genui-start')
    if (button === null) return
    button.disabled = !canStart()
    const { from, to } = dates()
    state.from = from
    state.to = to
    const count = document.querySelector('#proposal-card .bt-genui-foot .bt-genui-muted')
    if (count !== null) count.textContent = `${number(selected().length)} chats selected`
    const foot = document.querySelector('#proposal-card .bt-genui-foot')
    let error = foot?.querySelector('.bt-genui-error')
    if (from !== '' && to !== '' && from > to) {
      if (error === null || error === undefined) {
        error = document.createElement('span')
        error.className = 'bt-genui-error'
        error.textContent = 'The start date must be before the end date.'
        foot.appendChild(error)
      }
    } else if (error) {
      error.remove()
    }
  }

  function rowsForStart() {
    return state.chats.filter(chat => chat.ticked).map((chat, index) => ({
      id: chat.id, name: chat.name, jobId: `job-${chat.id}`,
      state: index === 0 ? 'fetching' : 'queued', outcome: null, fetched: index === 0 ? 320 : 0,
      media: '', marks: '', span: '',
    }))
  }

  function demoRun() {
    state.demo = true
    state.ticks = 1
    state.run = {
      rows: [
        { id: 'ana', name: 'Ana', state: 'fetching', outcome: null, fetched: 4180, media: '38 photos, 2 missing', marks: '5 reactions · 2 edits', span: '' },
        { id: 'bruno', name: 'Bruno', state: 'done', outcome: 'done', fetched: 4200, media: '38 photos, 2 missing', marks: '5 reactions · 2 edits', span: 'Mar–Nov' },
        { id: 'carla', name: 'Carla', state: 'failed', outcome: 'failed', fetched: 900, media: '', marks: '', span: '' },
        { id: 'davi', name: 'Davi', state: 'fetching', outcome: null, fetched: 2680, media: '', marks: '1 reaction', span: '' },
      ],
    }
  }

  function tick() {
    if (state.phase !== 'runs' || state.run === undefined) return
    state.ticks += 1
    const running = state.run.rows.filter(row => row.outcome === null)
    for (const row of running) {
      row.state = 'fetching'
      row.fetched = Math.min(4400, (row.fetched ?? 0) + 900)
      if (row.fetched > 1800) row.media = '38 photos, 2 missing'
      if (row.fetched > 2700) row.marks = '5 reactions · 2 edits'
    }
    if (state.demo) {
      render()
      return
    }
    // One chat's provider refuses it, and one finishes: the three end states a row can wear.
    if (state.ticks === 3 && running.length > 1) {
      const failed = running[running.length - 1]
      Object.assign(failed, { state: 'failed', outcome: 'failed' })
      state.message = `${failed.name}'s backfill failed. The others keep running.`
    }
    if (state.ticks === 5 && running.length > 0) {
      const done = running[0]
      Object.assign(done, { state: 'done', outcome: 'done', fetched: 4400, span: 'Mar–Nov' })
      state.message = `${done.name}'s backfill is done.`
    }
    render()
  }

  function beginRun() {
    state.phase = 'runs'
    state.demo = false
    state.run = { rows: rowsForStart() }
    state.ticks = 0
    state.message = summaryOf(state.run.rows) === '' ? 'Nothing to run: tick a chat first.' : 'Approval sent. The rows are moving.'
    render()
    clearInterval(state.timer)
    state.timer = setInterval(tick, 1100)
    tick()
  }

  function start() {
    if (!canStart()) return
    state.phase = 'starting'
    state.approval = 'sending'
    state.message = 'Sending your approval…'
    render()
    clearTimeout(state.firstTimer)
    clearTimeout(state.flipTimer)
    state.firstTimer = setTimeout(() => {
      state.approval = 'sent'
      state.message = 'Approval sent. Waiting for the first row.'
      render()
      state.flipTimer = setTimeout(beginRun, 900)
    }, 900)
  }

  function stop(id) {
    const row = state.run?.rows.find(item => item.id === id)
    if (row === undefined || row.outcome !== null) return
    Object.assign(row, { state: 'cancelled', outcome: 'stopped' })
    state.message = `Stopped the backfill of ${row.name}.`
    render()
  }

  function reset() {
    clearTimeout(state.firstTimer)
    clearTimeout(state.flipTimer)
    clearInterval(state.timer)
    state.phase = 'proposal'
    state.approval = 'sending'
    state.chats = sample.chats.map(chat => ({ ...chat }))
    state.run = undefined
    state.ticks = 0
    state.from = undefined
    state.to = undefined
    state.message = 'A proposal is waiting: nothing is running.'
    render()
  }

  function bind() {
    document.querySelector('#proposal-card .bt-genui-start')?.addEventListener('click', start)
    for (const input of document.querySelectorAll('#proposal-card [data-chat]')) {
      input.addEventListener('change', () => {
        const chat = state.chats.find(item => item.id === input.dataset.chat)
        if (chat !== undefined) chat.ticked = input.checked
        updateControls()
      })
    }
    for (const input of document.querySelectorAll('#proposal-card [data-date]')) {
      input.addEventListener('input', updateControls)
      input.addEventListener('change', updateControls)
    }
    for (const button of document.querySelectorAll('[data-stop]')) {
      button.addEventListener('click', () => stop(button.dataset.stop))
    }
  }

  for (const tab of document.querySelectorAll('[data-phase]')) {
    tab.addEventListener('click', () => {
      const phase = tab.dataset.phase
      if (phase === 'proposal') {
        reset()
        return
      }
      if (phase === 'starting') {
        clearInterval(state.timer)
        state.phase = 'starting'
        state.approval = 'sending'
        state.message = 'Sending your approval…'
        render()
        clearTimeout(state.firstTimer)
        clearTimeout(state.flipTimer)
        state.firstTimer = setTimeout(() => {
          state.approval = 'sent'
          state.message = 'Approval sent. Waiting for the first row.'
          render()
        }, 900)
        return
      }
      clearTimeout(state.firstTimer)
      clearTimeout(state.flipTimer)
      state.phase = 'runs'
      demoRun()
      state.message = 'Two chats are running, one is done and one failed; Stop ends a running one.'
      render()
      clearInterval(state.timer)
      state.timer = setInterval(tick, 1400)
    })
  }
  document.getElementById('reset').addEventListener('click', reset)

  const themes = ['light', 'dark']
  let theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const paintTheme = () => {
    if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    document.getElementById('theme').textContent = theme === 'dark' ? 'Light' : 'Dark'
  }
  document.getElementById('theme').addEventListener('click', () => {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length]
    paintTheme()
  })
  paintTheme()

  const initial = params.get('state')
  if (initial === 'runs') {
    state.phase = 'runs'
    demoRun()
    state.message = 'Two chats are running, one is done and one failed; Stop ends a running one.'
    state.timer = setInterval(tick, 1400)
  }
  if (initial === 'starting') {
    state.phase = 'starting'
    state.approval = 'sending'
    state.message = 'Sending your approval…'
    state.firstTimer = setTimeout(() => {
      state.approval = 'sent'
      state.message = 'Approval sent. Waiting for the first row.'
      render()
    }, 900)
  }
  render()
})()
