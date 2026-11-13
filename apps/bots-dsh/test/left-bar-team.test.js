// The new left bar's Team rows (left-bar-team.js): the front Bot first, then the Bots no section
// holds, then each section under a quiet label, then the group chats; channels and chats under
// their Bot; one line per row with one status; a status said once, where the owner goes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, hasClass, parts, render, textOf } from './left-bar-load.js'

const { TeamRows, botRowStatus, teamRows } = parts

const chat = (id, status = 'idle') => ({ id, name: `Chat ${id}`, status })
const bot = (id, more = {}) => ({ id, name: `Bot ${id}`, status: 'idle', ...more })
const HELP = { id: 'help', kind: 'whatsapp', name: 'Help desk', chats: [chat('a', 'working'), chat('b', 'needs')] }
const STORE = { id: 'store', kind: 'telegram', name: 'Storefront', folded: true, chats: [chat('c'), chat('d', 'error')] }
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
    'section:0', 'bot:pip', 'channel:pip/help', 'chat:pip/help/a', 'chat:pip/help/b', 'channel:pip/store', 'bot:kit',
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
  const rows = new Map(teamRows(TEAM).map(row => [row.key, row]))
  assert.equal(rows.get('bot:pip').status, 'idle', 'its chat already says needs you')
  assert.equal(rows.get('chat:pip/help/b').status, 'needs')
  assert.equal(rows.get('channel:pip/help').status, 'idle', 'an open channel leaves it to its chats')
  assert.equal(rows.get('channel:pip/store').status, 'error', 'a folded channel speaks for its chats')
  assert.equal(rows.has('chat:pip/store/c'), false, 'a folded channel hides its chats')
  assert.equal(botRowStatus(bot('x', { status: 'needs' })), 'needs', 'a Bot with no chat asking says it itself')
  assert.equal(botRowStatus(bot('x', { status: 'working', channels: [HELP] })), 'working', 'only needs you moves to the chat')
})

const draw = (props = {}) => render(TeamRows({
  team: TEAM, current: 'bot:front',
  renderArt: (who, size, state) => ({ type: 'i', props: { 'data-art': who.id, 'data-size': size, 'data-state': state }, children: [] }),
  renderGlyph: channel => ({ type: 'i', props: { 'data-glyph': channel.kind }, children: [] }),
  ...props,
}))
const row = (tree, key) => findAll(tree, node => node.type === 'button' && node.props['data-id'] === key)[0]

test('each row is one button on one line: art, name, one status', () => {
  const tree = draw()
  assert.equal(hasClass('lb-scroll')(tree), true)
  const list = tree.children[0]
  assert.equal(list.props.role, 'group')
  assert.equal(list.props['aria-label'], 'Team')
  const buttons = findAll(tree, node => node.type === 'button')
  assert.equal(buttons.length, keys(teamRows(TEAM)).filter(key => !key.startsWith('section:')).length)
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

test('the rows wear what they are: unread, not running, channel, chat, group', () => {
  const tree = draw()
  const unread = row(tree, 'new')
  assert.ok(hasClass('lb-row-unread')(unread))
  assert.equal(textOf(findAll(unread, hasClass('lb-sr'))[0]), 'Unread activity', 'unread is said, not only shown in weight')
  const off = row(tree, 'off')
  assert.ok(hasClass('lb-row-off')(off))
  assert.equal(findAll(off, node => node.props?.role === 'img')[0].props['aria-label'], 'Not running')
  // A Bot whose chat asks still plays "alert": the row is quiet, the character is not.
  assert.equal(findAll(row(tree, 'pip'), node => node.props?.['data-art'])[0].props['data-state'], 'alert')
  const help = row(tree, 'help')
  assert.ok(hasClass('lb-row-channel')(help))
  assert.equal(help.props['aria-expanded'], true)
  assert.equal(findAll(help, node => node.props?.['data-glyph'])[0].props['data-glyph'], 'whatsapp')
  assert.equal(findAll(help, hasClass('lb-chev')).length, 0, 'an open channel has no chevron')
  const store = row(tree, 'store')
  assert.equal(store.props['aria-expanded'], false)
  assert.equal(findAll(store, hasClass('lb-chev')).length, 1)
  assert.equal(findAll(store, node => node.props?.role === 'img')[0].props['aria-label'], 'Error')
  const asking = row(tree, 'b')
  assert.ok(hasClass('lb-row-chat')(asking) && hasClass('lb-row-hot')(asking), 'a chat with a status is in ink')
  assert.equal(textOf(asking), 'Chat bNeeds you')
  assert.equal(hasClass('lb-row-hot')(row(tree, 'a')), true)
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
