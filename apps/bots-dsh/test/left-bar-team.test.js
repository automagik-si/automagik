// The new left bar's Team rows (left-bar-team.js): the front Bot first, then the Bots no section
// holds, then each section under a quiet label, then the group chats; a Bot's channels and chats
// under its row, from the one source that serves it; one line per row with one status; a status
// said once, where the owner goes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, hasClass, parts, render, textOf } from './left-bar-load.js'

const { TeamRows, bakedFit, botChannels, botRowStatus, channelRows, channelStatusOf, chatStatusOf, teamOf, teamRows } = parts

const person = (name, more = {}) => ({ name, photo: null, self: false, ...more })
const chat = (id, status = 'idle', more = {}) => ({ id, name: `Chat ${id}`, status, who: person(`Person ${id}`), ...more })
const bot = (id, more = {}) => ({ id, name: `Bot ${id}`, status: 'idle', ...more })
const MIKA = person('Mika', { photo: 'https://example.test/mika.png' })
const ME = person('Me (notes)', { self: true })
const HELP = {
  id: 'help', kind: 'whatsapp', name: 'Help desk', status: 'connected',
  chats: [
    chat('a', 'answering', { lastAt: 2, who: MIKA }),
    chat('b', 'needs-someone', { lastAt: 3, unread: 2, who: person('Tess Alves') }),
    chat('s', 'idle', { lastAt: 1, who: ME }),
  ],
}
const STORE = {
  id: 'store', kind: 'telegram', name: 'Storefront', status: 'error',
  chats: [chat('c', 'idle', { lastAt: 1, who: person('Order 1042') }), chat('d', 'paused', { lastAt: 4, who: person('Ana') })],
}
const TEAM = {
  frontId: 'front',
  bots: [
    bot('loose'), bot('front', { status: 'working' }),
    bot('pip', { status: 'needs', channels: [HELP, STORE] }), bot('kit', { status: 'error' }), bot('off', { status: 'off' }), bot('new', { unread: true }),
  ],
  sections: [{ label: 'Desk', bots: ['front', 'pip', 'kit'] }, { label: 'Empty', bots: ['gone'] }, { label: 'Back', bots: ['off', 'new'] }],
  groups: [{ id: 'crew', name: 'Crew', members: ['kit', 'new'] }, { id: 'solo', name: 'Solo', members: ['loose', 'gone'] }],
}
const keys = rows => rows.map(row => row.key)

test('the rows run front Bot, loose Bots, sections, groups', () => {
  assert.deepEqual(keys(teamRows(TEAM)), [
    'bot:front', 'bot:loose',
    'section:0', 'bot:pip', 'bot:kit',
    // A section with no Bot left on the team draws no label.
    'section:1', 'bot:off', 'bot:new',
    'group:crew', 'group:solo',
  ])
  const rows = teamRows(TEAM)
  const labels = rows.filter(row => row.kind === 'section')
  assert.deepEqual(labels.map(row => [row.label, row.first]), [['Desk', true], ['Back', false]], 'only the first label stands clear of the front Bot')
  const groups = rows.filter(row => row.kind === 'group')
  assert.deepEqual(groups.map(row => row.lead), [true, false], 'the groups stand apart from the last section')
  assert.deepEqual(groups[1].members.map(member => member.id), ['loose'], 'a member no longer on the team is left out')
})

test('a team with no sections and no front Bot keeps its order', () => {
  const rows = teamRows({ bots: [bot('a'), bot('b')], groups: [{ id: 'g', name: 'G', members: ['a', 'b'] }] })
  assert.deepEqual(keys(rows), ['bot:a', 'bot:b', 'group:g'])
  assert.equal(rows.at(-1).lead, false, 'without sections the groups need no gap')
  assert.deepEqual(teamRows(undefined), [])
  assert.deepEqual(teamRows({ bots: [] }), [])
})

test('a status is said once: by the chat, or by the folded channel that holds it', () => {
  const rows = new Map(channelRows({ id: 'pip', channelSource: undefined }, [HELP, STORE], new Set(['pip/store'])).map(row => [row.key, row]))
  assert.equal(rows.get('chat:pip/help/b').status, 'needs', 'Omni says "needs-someone", the bar says needs')
  assert.equal(rows.get('chat:pip/help/a').status, 'working', 'Omni says "answering", the bar says working')
  assert.equal(rows.get('chat:pip/help/s').status, 'idle')
  assert.equal(rows.get('channel:pip/help').status, 'idle', 'an open channel leaves it to its chats')
  assert.equal(rows.get('channel:pip/store').status, 'error', 'a folded channel speaks for its chats and its own state')
  assert.equal(rows.has('chat:pip/store/c'), false, 'a folded channel hides its chats')
  assert.equal(botRowStatus(bot('x', { status: 'needs' })), 'needs', 'a Bot with no chat asking says it itself')
  assert.equal(botRowStatus(bot('x', { status: 'working', channels: [HELP] })), 'working', 'only needs you moves to the chat')
  assert.equal(botRowStatus(bot('x', { status: 'needs', channels: [HELP] })), 'idle', 'its chat already asks')
})

test('Omni\'s channel and chat words, and a channel that is not running', () => {
  assert.deepEqual(['connected', 'needs-pairing', 'disconnected', 'error'].map(status => channelStatusOf({ status })), ['idle', 'needs', 'off', 'error'])
  assert.deepEqual(['answering', 'paused', 'needs-someone', 'idle'].map(status => chatStatusOf({ status })), ['working', 'idle', 'needs', 'idle'])
  const off = { id: 'off', kind: 'slack', name: 'Off', status: 'disconnected', chats: [chat('z')] }
  const pairing = { id: 'pair', kind: 'telegram', name: 'Pair', status: 'needs-pairing', chats: [chat('y')] }
  const rows = new Map(channelRows({ id: 'b' }, [off, pairing], new Set(['b/off', 'b/pair'])).map(row => [row.id, row]))
  assert.equal(rows.get('off').status, 'off', 'a channel that is not running keeps its off')
  assert.equal(rows.get('pair').status, 'needs')
})

test('a closed Bot carries a channel that needs the person up to its own row', () => {
  const closed = { ...HELP, status: 'needs-pairing', chats: undefined }
  assert.equal(botRowStatus(bot('x', { status: 'idle', channels: [closed] })), 'needs', 'the row he sees all day says so')
  assert.equal(botRowStatus(bot('x', { status: 'working', channels: [closed] })), 'needs', 'needs asks first')
  assert.equal(botRowStatus(bot('x', { status: 'idle', channels: [HELP] })), 'idle', 'an open Bot leaves it to the chat rows')
  assert.equal(botRowStatus(bot('x', { status: 'idle', channels: [{ ...closed, status: 'connected' }] })), 'idle')
})

test('a channel stays folded until a source read its chats; its own state speaks meanwhile', () => {
  const unread = { ...HELP, chats: undefined }
  const rows = channelRows({ id: 'pip' }, [unread], new Set())
  assert.equal(rows[0].folded, true, 'chats unknown: folded')
  assert.equal(rows[0].status, 'idle')
  assert.equal(rows.length, 1)
  const loaded = channelRows({ id: 'pip' }, [{ ...HELP, chats: [] }], new Set())
  assert.equal(loaded[0].folded, false, 'chats known, even empty: open')
})

const draw = (props = {}) => render(TeamRows({
  team: TEAM, current: 'bot:front', folded: new Set(['pip/store']),
  renderArt: (who, size, state) => ({ type: 'i', props: { 'data-art': who.id, 'data-size': size, 'data-state': state }, children: [] }),
  renderGlyph: channel => ({ type: 'i', props: { 'data-glyph': channel.kind }, children: [] }),
  ...props,
}))
const row = (tree, key) => findAll(tree, node => node.type === 'button' && node.props['data-id'] === key)[0]
const rowsOf = tree => findAll(tree, node => node.type === 'button' && node.props['data-kind']).map(node => node.props['data-id'])

test('each row is one button on one line: art, name, one status', () => {
  const tree = draw()
  assert.equal(hasClass('lb-scroll')(tree), true)
  const list = tree.children[0]
  assert.equal(list.props.role, 'group')
  assert.equal(list.props['aria-label'], 'Team')
  assert.deepEqual(rowsOf(tree), ['front', 'loose', 'pip', 'help', 'b', 'a', 's', 'store', 'kit', 'off', 'new', 'crew', 'solo'])
  const buttons = findAll(tree, node => node.type === 'button')
  for (const button of buttons) {
    assert.equal(button.props.type, 'button')
    assert.ok(findAll(button, node => node.props?.role === 'img').length <= 1, `${button.props['data-id']}: at most one mark`)
  }
  const front = row(tree, 'front')
  assert.equal(front.props['aria-current'], 'page', 'the open row')
  assert.equal(textOf(front), 'Bot front')
  assert.deepEqual(findAll(front, node => node.props?.['data-art'])[0].props, { 'data-art': 'front', 'data-size': 28, 'data-state': 'working' }, 'the art at 28, playing its status')
  assert.equal(findAll(front, node => node.props?.role === 'img')[0].props['aria-label'], 'Working')
  assert.equal(row(tree, 'loose').props['aria-current'], undefined)
  assert.equal(findAll(row(tree, 'loose'), node => node.props?.role === 'img').length, 0, 'an idle Bot shows no mark')
})

test('a Bot\'s channels run newest chat first, each with its own mark', () => {
  const tree = draw()
  const help = row(tree, 'help')
  assert.ok(hasClass('lb-row-channel')(help))
  assert.equal(help.props['aria-expanded'], true)
  assert.equal(findAll(help, node => node.props?.['data-glyph'])[0].props['data-glyph'], 'whatsapp')
  assert.equal(findAll(help, hasClass('lb-chev')).length, 1, 'an open channel still says it can fold')
  assert.ok(hasClass('lb-chev-open')(findAll(help, hasClass('lb-chev'))[0]), 'open: the chevron points down')
  const store = row(tree, 'store')
  assert.equal(store.props['aria-expanded'], false)
  assert.equal(findAll(store, hasClass('lb-chev')).length, 1)
  assert.equal(hasClass('lb-chev-open')(findAll(store, hasClass('lb-chev'))[0]), false, 'folded: the chevron points right')
  assert.equal(findAll(store, node => node.props?.role === 'img')[0].props['aria-label'], 'Error')
  const asking = row(tree, 'b')
  assert.ok(hasClass('lb-row-chat')(asking) && hasClass('lb-row-hot')(asking), 'a chat with a status is in ink')
  assert.equal(textOf(asking), 'TAChat bUnread activity2Needs you')
  assert.equal(hasClass('lb-row-hot')(row(tree, 'a')), true, 'answering is work, in ink')
  assert.equal(hasClass('lb-row-hot')(row(tree, 's')), false, 'an idle chat stays quiet')
  // A paused chat draws no mark of its own.
  assert.equal(findAll(row(tree, 's'), node => node.props?.role === 'img').length, 0)
})

test('a chat row shows its person: the photo, initials when there is none, and the owner\'s own tone', () => {
  const tree = draw()
  const face = key => findAll(row(tree, key), hasClass('lb-chat-face'))[0]
  const mika = face('a')
  assert.equal(findAll(mika, node => node.type === 'img')[0].props.src, 'https://example.test/mika.png')
  assert.equal(mika.props['data-self'], undefined)
  const tess = face('b')
  assert.equal(findAll(tess, node => node.type === 'img').length, 0, 'no photo: initials')
  assert.equal(textOf(findAll(tess, hasClass('lb-chat-face-initials'))[0]), 'TA')
  assert.equal(tess.props['data-self'], undefined, 'another person wears the incoming tone')
  const mine = face('s')
  assert.equal(mine.props['data-self'], '', 'the owner\'s own chat wears the outgoing tone')
  assert.equal(textOf(findAll(mine, hasClass('lb-chat-face-initials'))[0]), 'MN')
})

test('a chat\'s unread is said, counted and weighs its name; a folded channel wears it', () => {
  const tree = draw()
  const unread = row(tree, 'b')
  assert.ok(hasClass('lb-row-unread')(unread))
  assert.equal(textOf(findAll(unread, hasClass('lb-sr'))[0]), 'Unread activity', 'unread is said, not only shown in weight')
  assert.equal(textOf(findAll(unread, hasClass('lb-count'))[0]), '2', 'its count is drawn')
  assert.equal(hasClass('lb-row-unread')(row(tree, 'a')), false)
  assert.ok(hasClass('lb-row-unread')(row(tree, 'help')), 'a channel says one of its chats is unread')
  assert.equal(hasClass('lb-row-unread')(row(tree, 'store')), false)
  const many = channelRows({ id: 'b' }, [{ ...HELP, chats: [chat('m', 'idle', { unread: 150 })] }], new Set())
  assert.equal(many[1].unreadCount, 150)
  const capped = render(TeamRows({
    team: { bots: [{ ...bot('c'), channels: [{ ...HELP, chats: [chat('m', 'idle', { unread: 150 })] }] }] },
    renderArt: () => ({ type: 'i', props: {}, children: [] }),
  }))
  assert.equal(textOf(findAll(capped, hasClass('lb-count'))[0]), '99+', 'past 99 it counts no further')
})

test('the rows wear what they are: unread, not running, groups and labels', () => {
  const tree = draw()
  const unread = row(tree, 'new')
  assert.ok(hasClass('lb-row-unread')(unread))
  const off = row(tree, 'off')
  assert.ok(hasClass('lb-row-off')(off))
  assert.match(textOf(off), /Not running/, 'not running is said in words, never a bare hollow ring')
  // A Bot whose chat asks still plays "alert": the row is quiet, the character is not.
  assert.equal(findAll(row(tree, 'pip'), node => node.props?.['data-art'])[0].props['data-state'], 'alert')
  const crew = row(tree, 'crew')
  assert.ok(hasClass('lb-row-lead')(crew))
  assert.deepEqual(findAll(crew, node => node.props?.['data-art']).map(art => [art.props['data-art'], art.props['data-size']]), [['kit', 19], ['new', 19]], 'two members, at 19 each')
  assert.deepEqual(findAll(row(tree, 'solo'), node => node.props?.['data-art']).map(art => art.props['data-size']), [28], 'one member alone takes the full box')
  const labels = findAll(tree, hasClass('lb-sec'))
  assert.deepEqual(labels.map(textOf), ['Desk', 'Back'])
  assert.ok(hasClass('lb-sec-first')(labels[0]) && !hasClass('lb-sec-first')(labels[1]))
})

test('a press hands over its row; without a listener nothing is wired', () => {
  const opened = []
  const tree = draw({ onOpen: pressed => opened.push(pressed.key) })
  row(tree, 'store').props.onClick()
  row(tree, 'b').props.onClick()
  row(tree, 'crew').props.onClick()
  assert.deepEqual(opened, ['channel:pip/store', 'chat:pip/help/b', 'group:crew'])
  assert.equal(row(draw(), 'front').props.onClick, undefined)
})

test('the statuses that show a word are the caller\'s to choose', () => {
  const tree = draw({ worded: ['needs', 'working'] })
  assert.equal(textOf(row(tree, 'front')), 'Bot frontWorking')
  assert.equal(draw({ label: 'Studio' }).children[0].props['aria-label'], 'Studio')
})

test('the registry picks the one source that serves a Bot, by its id or its ownership', () => {
  const before = botChannels.entries().length
  const pip = bot('pip', { kind: 'omni' })
  const byOwns = { id: 'by-owns', owns: candidate => candidate.kind === 'omni', useChannels: () => [], open: () => {} }
  const offOwns = botChannels.register(byOwns)
  assert.equal(teamOf({ roster: rosterOf([pip]), order: [], status: emptyStatus(), marked: {} }).bots[0].channelSource, byOwns)
  assert.equal(teamOf({ roster: rosterOf([bot('kit')]), order: [], status: emptyStatus(), marked: {} }).bots[0].channelSource, undefined)
  const byId = { id: 'by-id', botId: 'pip', useChannels: () => [], open: () => {} }
  const offId = botChannels.register(byId)
  assert.equal(teamOf({ roster: rosterOf([pip]), order: [], status: emptyStatus(), marked: {} }).bots[0].channelSource, byId, 'the one naming the id wins')
  offId()
  assert.equal(teamOf({ roster: rosterOf([pip]), order: [], status: emptyStatus(), marked: {} }).bots[0].channelSource, byOwns)
  offOwns()
  assert.equal(botChannels.entries().length, before, 'the disposer takes it off')
})

function rosterOf (bots) {
  return { bots, rooms: [], agents: [], mainBotId: bots[0]?.id, mainBotIds: [bots[0]?.id], byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), questions: {} }
}
const emptyStatus = () => ({ bots: new Map(), dsh: new Map(), groups: new Map() })

test('a source is asked for a Bot\'s channels only while that Bot\'s Session is shown or one of its channels was unfolded', () => {
  const calls = []
  const source = { id: 'fake', botId: 'pip', useChannels: (botId, options) => { calls.push([botId, options.open]); return [HELP] }, open: () => {} }
  const off = botChannels.register(source)
  try {
    render(TeamRows({
      team: { bots: [bot('pip'), bot('kit')] }, current: 'bot:pip', folded: new Set(), loads: id => id === 'pip',
      renderArt: who => ({ type: 'i', props: { 'data-art': who.id }, children: [] }),
    }))
    assert.deepEqual(calls, [['pip', true]], 'the open Bot only')
    calls.length = 0
    render(TeamRows({ team: { bots: [bot('pip'), bot('kit')] }, folded: new Set(), loads: () => false, renderArt: () => ({ type: 'i', props: {}, children: [] }) }))
    assert.deepEqual(calls, [['pip', false]], 'a closed Bot is asked with open false, and its source reads no chats')
  } finally { off() }
})

test('a baked character is fitted by its own box, drawn a twentieth larger, as the design trims it close; Omni\'s by one a twelfth larger', () => {
  // A cell is 208 tall. A character stands 150 tall on the floor at 196, so its middle is at 121.
  const pet = bakedFit({ shape: 'star', color: 'teal' })
  assert.equal(pet.fit, (208 / 150) * (21 / 20))
  assert.equal(pet.lift, (121 - 104) / 208)
  assert.ok(Math.abs(28 * pet.fit * 150 / 208 - 28 * 21 / 20) < 1e-9, 'its box is the art\'s a twentieth larger')
  // Omni's own is baked 166 tall with its feet at 198 (pet-bake.js): its middle is at 115.
  const omni = bakedFit({ clay: 'omni' })
  assert.equal(omni.fit, (208 / (166 * 13 / 12)) * (21 / 20))
  assert.equal(omni.lift, (115 - 104) / 208)
  const paints = 28 * omni.fit * 166 / 208
  assert.ok(paints > 26.5 && paints < 27.5, `Omni's character paints ${paints.toFixed(2)} px of an art box of 28`)
  assert.deepEqual(bakedFit(undefined), pet)
})
