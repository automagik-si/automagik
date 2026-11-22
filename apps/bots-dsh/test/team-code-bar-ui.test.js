import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, hasClass, parts, render, textOf } from './left-bar-load.js'

const { teamOf, TeamRows } = parts
const club = { id: 'dsh-main', name: 'Main', workDir: '/main' }
const dsh = { id: 'dsh-dev', name: 'DSH Bot', workDir: '/p/./work/..' }
const group = { id: 'room', name: 'Room' }
const roster = { mainBotId: club.id, byId: { [club.id]: club, [dsh.id]: dsh } }
const order = [{ kind: 'bot', item: dsh }, { kind: 'room', item: group }]
const status = { bots: new Map(), dsh: new Map(), groups: new Map() }
const first = { id: 'b-aaaaaaaaaa', key: 'b-aaaaaaaaaa', name: 'Another Global', kind: 'global', folder: null, status: 'idle' }
const go = { id: 'b-bbbbbbbbbb', key: 'b-bbbbbbbbbb', name: 'GO', main: true, kind: 'global', folder: null, status: 'idle' }
const project = { id: 'b-cccccccccc', key: 'b-cccccccccc', name: 'Project Lead', main: true, kind: 'main', project: 'Alpha', folder: '/p', status: 'idle', terminal: 't1' }
const sibling = { id: 'b-dddddddddd', key: 'b-dddddddddd', name: 'Project Bot', kind: 'bot', project: 'Alpha', folder: '/p', status: 'idle' }
const remote = { ...project, key: project.id + '@box', name: 'Remote Lead', project: 'Box', machine: 'box', status: 'off', terminal: null }
const build = (front, seats = [first, go, remote, project, sibling]) => teamOf({ roster, order, status, seats, front })
const frontOf = seat => ({ project: seat.folder, bot: seat.id, ...(seat.machine ? { machine: seat.machine } : {}) })

test('Team orders the chosen front, GO, project mains, DSH Bots and groups once each', () => {
  for (const [front, names] of [
    [null, ['Main', 'GO', 'Another Global', 'Project Lead', 'Remote Lead', 'DSH Bot']],
    [frontOf(sibling), ['Project Bot', 'GO', 'Another Global', 'Project Lead', 'Remote Lead', 'Main', 'DSH Bot']],
    [frontOf(go), ['GO', 'Another Global', 'Project Lead', 'Remote Lead', 'Main', 'DSH Bot']],
    [frontOf(project), ['Project Lead', 'GO', 'Another Global', 'Remote Lead', 'Main', 'DSH Bot']],
    [frontOf(remote), ['Remote Lead', 'GO', 'Another Global', 'Project Lead', 'Main', 'DSH Bot']],
    [{ project: '/p', bot: dsh.id }, ['DSH Bot', 'GO', 'Another Global', 'Project Lead', 'Remote Lead', 'Main']],
    [{ project: '/q', bot: dsh.id }, ['Main', 'GO', 'Another Global', 'Project Lead', 'Remote Lead', 'DSH Bot']],
    [{ project: '/p', bot: 'b-eeeeeeeeee' }, ['Main', 'GO', 'Another Global', 'Project Lead', 'Remote Lead', 'DSH Bot']],
  ]) {
    const team = build(front)
    assert.deepEqual(team.bots.map(bot => bot.name), names)
    assert.equal(team.frontId, team.bots[0].id)
    assert.deepEqual(team.groups.map(room => room.id), [group.id])
    assert.equal(new Set(team.bots.map(bot => bot.id)).size, team.bots.length)
  }
})

test('unmarked or multiply marked globals keep home order, and a sole global occupies the GO slot', () => {
  const third = { ...first, id: 'b-eeeeeeeeee', key: 'b-eeeeeeeeee', name: 'Third' }
  const unmarked = build(null, [first, { ...go, main: false }, third])
  assert.deepEqual(unmarked.bots.map(bot => bot.name), ['Main', 'Another Global', 'GO', 'Third', 'DSH Bot'])
  assert.equal(unmarked.frontId, club.id)
  const multiple = build(null, [first, go, { ...third, main: true }])
  assert.deepEqual(multiple.bots.map(bot => bot.name), ['Main', 'Another Global', 'GO', 'Third', 'DSH Bot'])
  const only = build(null, [project, first])
  assert.deepEqual(only.bots.map(bot => bot.name), ['Main', 'Another Global', 'Project Lead', 'DSH Bot'])
})

test('the local and remote namesakes keep separate row ids and the remote row cannot open', () => {
  const calls = []
  const team = build(frontOf(remote))
  const rows = render(TeamRows({ team, onOpen: row => calls.push(row.id), renderArt: () => null }))
  const buttonFor = id => findAll(rows, node => node.type === 'button' && node.props['data-id'] === id)[0]
  const local = buttonFor('seat:' + project.key)
  const far = buttonFor('seat:' + remote.key)
  const global = buttonFor('seat:' + go.key)
  assert.equal(team.frontId, 'seat:' + remote.key)
  assert.deepEqual(findAll(local, hasClass('bt-tag')).map(textOf), ['Alpha'])
  assert.deepEqual(findAll(global, hasClass('bt-tag')), [])
  assert.equal(findAll(local, node => node.props.title === 'Idle').length, 1)
  assert.equal(far.props['aria-disabled'], true)
  assert.match(far.props.title, /box.*link/)
  assert.equal(hasClass('lb-row-off')(far), true)
  assert.deepEqual(findAll(far, hasClass('bt-tag')).map(textOf), ['Needs the scoped link'])
  // The tag says why the row is inert: its status is the ring alone, so the name keeps its room.
  assert.deepEqual(findAll(far, hasClass('lb-st')), [])
  assert.equal(findAll(far, hasClass('lb-mark')).length, 1)
  assert.deepEqual(findAll(far, hasClass('lb-name')).map(textOf), ['Remote Lead'])
  far.props.onClick?.()
  far.props.onKeyDown?.({ key: 'Enter' })
  assert.deepEqual(calls, [])
  local.props.onClick()
  assert.deepEqual(calls, ['seat:' + project.key])
})
