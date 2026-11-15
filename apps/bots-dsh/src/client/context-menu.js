import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { inkFill } from './inks.js'
import { isMainOf } from './sources.js'
import { currentPart } from './text.js'
import { GearIcon, PinIcon, UnreadIcon, PencilIcon, StarLineIcon, CopyIcon, HideIcon, TrashIcon, DuplicateIcon, FolderIcon, PlusIcon, CheckIcon, PeopleIcon, SignOutIcon } from './icons.js'
import { BotMark, RoomAvatar } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import { stepMenuFocus, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

const SECTION_COLORS = ['blue', 'orange', 'green', 'violet', 'rose']
// Sections are kept as data, and our own bar does not draw them yet (that is its own piece
// of work). Until it does, no menu makes or fills one: a section nobody can see would only
// lose the chat it holds.
export const SECTIONS_IN_BAR = false

function sectionMoveItems(entry, roster, actions) {
  if (!SECTIONS_IN_BAR) return []
  const sections = roster.sections ?? []
  return [
    ...sections.map(sec => [
      sec.name,
      FolderIcon,
      () => actions.setFlags(entry.id, { sectionId: entry.sectionId === sec.id ? null : sec.id }),
      false,
      entry.sectionId === sec.id,
    ]),
    entry.sectionId ? [t('Remove from section'), FolderIcon, () => actions.setFlags(entry.id, { sectionId: null })] : null,
    [t('Move to new section…'), PlusIcon, async () => {
      const sec = await actions.saveSection({ items: [entry.id] })
      if (sec?.id) actions.beginSectionRename(sec.id)
    }],
  ].filter(Boolean)
}

export function ContextMenu({ menu, roster, actions, useWork, leaving = false }) {
  useEscape(() => actions.closeMenu())
  const ref = useRef(null)
  const trigger = useRef(typeof document === 'undefined' ? null : document.activeElement)
  useEffect(() => {
    const onDown = (event) => { if (!(event.target instanceof Element) || !event.target.closest('.bt-menu')) actions.closeMenu() }
    const onKey = (event) => { stepMenuFocus(ref.current, event, trigger.current) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [])
  const [place, setPlace] = useState({ left: menu.x, top: menu.y })
  const tick = useViewport()
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
  }, [menu.x, menu.y, tick])
  if (menu.kind === 'agent' || menu.kind === 'agent-session') return h(AgentMenu, { menu, roster, actions, leaving })
  if (menu.kind === 'section' || menu.kind === 'section-add') return h(SectionMenu, { menu, roster, actions, leaving })
  const bot = roster.byId[menu.id]
  const room = roster.roomsById[menu.id]
  const entry = bot ?? room
  // Only a Bot that is waiting on a hand-off offers to give one up.
  const waitsRaw = useWork && bot ? useWork(work => JSON.stringify(work.waiting?.[bot.id] ?? null)) : 'null'
  const waits = useMemo(() => JSON.parse(waitsRaw), [waitsRaw])
  if (entry === undefined) return null
  const isMainBot = isMainOf(roster, menu.id)
  const isTile = roster.mainBotId === menu.id
  const mainCount = (roster.mainBotIds ?? []).length
  // An adopted original is still a Bot record, but the host refuses deleting it until
  // adoption is rolled back. Offer that supported undo instead of an action that fails.
  const adopted = bot?.dshAgentId !== undefined
  // The host also refuses rollback while the Bot is Main, remains a member of any group,
  // or owns tasks/new team history. Do not offer an action that is guaranteed to fail.
  // Whether the history still matches (no New conversation since adoption) is the host's
  // own check, sent as `adoptionHistoryMatches`; anything but true hides rollback.
  const adoptedRoom = adopted
    ? Object.values(roster.roomsById ?? {}).find(room => (room.members ?? []).includes(bot.id))
    : undefined
  const adoptedTask = adopted ? Object.values(roster.tasks ?? {}).some(task => task.from === bot.id) : false
  const rollbackBlocked = isMainBot ? 'main' : adoptedRoom !== undefined ? 'groups' : adoptedTask ? 'tasks'
    : adopted && bot.adoptionHistoryMatches !== true ? 'history' : undefined
  const canRollback = adopted && rollbackBlocked === undefined
  const groups = [
    [
      isTile ? null : [entry.pinned ? t('Unpin') : t('Pin'), PinIcon, () => actions.setFlags(menu.id, { pinned: !entry.pinned })],
      [t('Mark as Unread'), UnreadIcon, () => actions.markUnread(menu.id)],
    ],
    isTile ? [] : sectionMoveItems(entry, roster, actions),
    [
      bot ? [t('Rename Bot'), PencilIcon, () => actions.renameBot(bot.id)] : null,
      bot ? [t('Edit Bot'), GearIcon, () => actions.openSettings('bots', bot.id)] : null,
      room ? [t('Group settings'), GearIcon, () => actions.openSettings('groups', room.id)] : null,
      room ? [t('Rename group'), PencilIcon, () => actions.renameBot(room.id)] : null,
      bot ? [t('Duplicate'), DuplicateIcon, async () => { const copy = await actions.duplicateBot(bot.id); actions.openSession(copy.id) }] : null,
      bot && !isMainBot ? [t('Make Main Bot'), StarLineIcon, () => actions.setMain(bot.id, true)] : null,
      bot && isMainBot && mainCount > 1 ? [t('Remove Main Bot role'), StarLineIcon, () => actions.setMain(bot.id, false)] : null,
    ],
    [
      // The Bot goes on in a fresh conversation; earlier parts stay readable.
      bot ? [t('New conversation'), PlusIcon, () => actions.freshConversation(bot.id)] : null,
      [t('Copy conversation ID'), CopyIcon, () => navigator.clipboard?.writeText(bot ? currentPart(bot) : menu.id)],
    ],
    bot ? (waits?.waits ?? []).map(item => [t('Give up waiting for {name}', { name: item.name ?? t('a Bot') }), SignOutIcon, () => actions.abandonWork(item.id)]) : [],
    [
      isMainBot ? null : [t('Hide from sidebar'), HideIcon, () => actions.setFlags(menu.id, { hidden: true })],
      isMainBot || adopted ? null : [room ? t('Delete group') : t('Delete'), TrashIcon, () => (bot ? actions.deleteBot(bot.id) : actions.deleteRoom(menu.id)), true],
      // Only a confirmed rollback whose host preconditions are visible as met is offered.
      canRollback ? [t('Roll back DSH adoption…'), TrashIcon, () => {
        const warning = t('Roll back this adoption? This deletes the Bot record and any settings changed after adoption; the original DSH bot and its session return.')
        if (typeof window.confirm !== 'function' || !window.confirm(warning)) return
        return actions.rollbackAdoption(bot.dshAgentId)
      }, false, false, 'bt-menu-note'] : null,
    ],
  ].map(group => group.filter(Boolean)).filter(group => group.length > 0)
  return h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': t('{name} actions', { name: bot?.name ?? room.name }), style: place, 'data-leaving': leaving || undefined },
    groups.map((group, index) => h(Fragment, { key: index },
      index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      group.map(([label, Icon, run, danger, checked, describedBy]) => h('button', {
        key: label, type: 'button', role: 'menuitem', className: danger ? 'bt-danger' : undefined,
        'aria-describedby': describedBy,
        onClick: () => { actions.closeMenu(); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
      }, h(Icon), h('span', { className: 'bt-menu-label' }, label), checked ? h('span', { className: 'bt-menu-check' }, h(CheckIcon)) : null)))),
    adopted ? h('div', { className: 'bt-menu-note', id: 'bt-menu-note', role: 'presentation' },
      rollbackBlocked !== undefined
        ? t('Rollback is unavailable until this Bot leaves all groups, is not a Main Bot, and has no tasks or new team history. Delete is also unavailable for an adopted original.')
        : t('Rolling back removes this Bot and any settings changed after adoption; the original DSH bot and its session return. A confirmation is required.')) : null)
}

function SectionMenu({ menu, roster, actions, leaving }) {
  const ref = useRef(null)
  const trigger = useRef(typeof document === 'undefined' ? null : document.activeElement)
  useEffect(() => {
    const onKey = (event) => { stepMenuFocus(ref.current, event, trigger.current) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const [place, setPlace] = useState({ left: menu.x, top: menu.y })
  const tick = useViewport()
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
  }, [menu.x, menu.y, tick])
  const sections = roster.sections ?? []
  const index = sections.findIndex(sec => sec.id === menu.id)
  const sec = sections[index]
  if (sec === undefined) return null
  if (menu.kind === 'section-add') {
    const candidates = [
      ...roster.bots.filter(bot => bot.id !== roster.mainBotId && !bot.hidden).map(bot => ({ kind: 'bot', item: bot })),
      ...roster.rooms.filter(room => !room.hidden).map(room => ({ kind: 'room', item: room })),
    ]
    return h('div', { ref, className: 'bt-menu bt-sec-add-menu', role: 'menu', 'aria-label': t('Add to {name}', { name: sec.name }), style: place, 'data-leaving': leaving || undefined },
      h('button', {
        type: 'button', role: 'menuitem',
        onClick: () => { actions.closeMenu(); actions.openNewChat('create', sec.id) },
      }, h(PlusIcon), h('span', { className: 'bt-menu-label' }, t('Create new Bot'))),
      h('button', {
        type: 'button', role: 'menuitem',
        onClick: () => { actions.closeMenu(); actions.openNewChat('group', sec.id) },
      }, h(PeopleIcon), h('span', { className: 'bt-menu-label' }, t('Create group chat'))),
      candidates.length > 0 ? h(Fragment, null,
        h('div', { className: 'bt-menu-sep', role: 'separator' }),
        h('div', { className: 'bt-menu-sub-head' }, t('Add existing')),
        h('div', { className: 'bt-sec-add-list' },
          candidates.map(({ kind, item }) => {
            const inside = item.sectionId === sec.id
            const otherSec = item.sectionId && !inside ? sections.find(s => s.id === item.sectionId)?.name : undefined
            return h('button', {
              key: item.id, type: 'button', role: 'menuitem',
              onClick: () => {
                actions.closeMenu()
                void Promise.resolve(actions.setFlags(item.id, { sectionId: inside ? null : sec.id })).catch(error => actions.reportError(error, 'menu'))
              },
            },
            kind === 'room' ? h(RoomAvatar, { room: item, roster, size: 18 }) : h(BotMark, { bot: item, size: 18 }),
            h('span', { className: 'bt-menu-label' }, item.name),
            inside ? h('span', { className: 'bt-menu-check' }, h(CheckIcon)) : otherSec ? h('span', { className: 'bt-menu-hint' }, otherSec) : null)
          }))) : null)
  }
  const move = (delta) => {
    const next = sections.map(entry => entry.id)
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [picked] = next.splice(index, 1)
    next.splice(target, 0, picked)
    void Promise.resolve(actions.reorderSections(next)).catch(error => actions.reportError(error, 'menu'))
  }
  return h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': t('{name} actions', { name: sec.name }), style: place, 'data-leaving': leaving || undefined },
    h('button', {
      type: 'button', role: 'menuitem',
      onClick: () => { actions.closeMenu(); actions.beginSectionRename(sec.id) },
    }, h(PencilIcon), h('span', { className: 'bt-menu-label' }, t('Rename section'))),
    h('button', {
      type: 'button', role: 'menuitem',
      onClick: () => { actions.closeMenu(); actions.openNewChat('create', sec.id) },
    }, h(PlusIcon), h('span', { className: 'bt-menu-label' }, t('Create new Bot'))),
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('div', { className: 'bt-menu-sub-head' }, t('Section color')),
    h('div', { className: 'bt-menu-colors' },
      h('button', {
        type: 'button', className: 'bt-menu-color-dot', 'aria-label': t('None'), title: t('None'), 'aria-pressed': !sec.color,
        style: { background: 'var(--bt-hover)' },
        onClick: () => { actions.closeMenu(); void Promise.resolve(actions.saveSection({ id: sec.id, color: null })).catch(error => actions.reportError(error, 'menu')) },
      }),
      SECTION_COLORS.map(color => h('button', {
        key: color, type: 'button', className: 'bt-menu-color-dot', 'aria-label': t(color[0].toUpperCase() + color.slice(1)), title: t(color[0].toUpperCase() + color.slice(1)), 'aria-pressed': sec.color === color,
        style: { background: inkFill(color) },
        onClick: () => { actions.closeMenu(); void Promise.resolve(actions.saveSection({ id: sec.id, color })).catch(error => actions.reportError(error, 'menu')) },
      }))),
    index > 0 ? h('button', { type: 'button', role: 'menuitem', onClick: () => { actions.closeMenu(); move(-1) } }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Move section up'))) : null,
    index < sections.length - 1 ? h('button', { type: 'button', role: 'menuitem', onClick: () => { actions.closeMenu(); move(1) } }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Move section down'))) : null,
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('button', {
      type: 'button', role: 'menuitem', className: 'bt-danger',
      onClick: () => { actions.closeMenu(); void Promise.resolve(actions.deleteSection(sec.id)).catch(error => actions.reportError(error, 'menu')) },
    }, h(TrashIcon), h('span', { className: 'bt-menu-label' }, t('Ungroup section'))))
}

// Menus for a DSH bot row (or the tasks row) and its Sessions; none of the Bot entries apply.
function AgentMenu({ menu, roster, actions, leaving }) {
  const ref = useRef(null)
  const trigger = useRef(typeof document === 'undefined' ? null : document.activeElement)
  useEffect(() => {
    const onKey = (event) => { stepMenuFocus(ref.current, event, trigger.current) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const [place, setPlace] = useState({ left: menu.x, top: menu.y })
  const tick = useViewport()
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
  }, [menu.x, menu.y, tick])
  const agent = roster.agentsById[menu.kind === 'agent' ? menu.id : menu.agentId]
  if (agent === undefined) return null
  const groups = menu.kind === 'agent'
    ? [
        [
          [agent.pinned ? t('Unpin') : t('Pin'), PinIcon, () => actions.setFlags(agent.id, { pinned: !agent.pinned })],
          ...(agent.kind === 'tasks' ? [] : [[t('Edit'), PencilIcon, () => actions.openNewChat(`dsh-bot:${agent.id}`)]]),
          // Its Session, folder and name carry over into a Bot with the team tools.
          ...(agent.kind === 'tasks' ? [] : [[t('Adopt as Bot'), PeopleIcon, () => actions.adoptAgentAsBot(agent.id)]]),
        ],
        sectionMoveItems(agent, roster, actions),
        [
          [agent.kind === 'tasks' ? t('Remove Tasks') : t('Remove {name}', { name: agent.name }), TrashIcon, () => actions.removeAgent(agent.id), true],
        ],
      ].filter(group => group.length > 0)
    : [
        [
          [t('Rename'), PencilIcon, () => actions.beginAgentRename(menu.id)],
        ],
        [
          [t('Archive'), TrashIcon, () => actions.archiveAgentSession(agent.id, menu.id), true],
        ],
      ]
  return h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': menu.kind === 'agent' ? (agent.kind === 'tasks' ? t('Tasks') : agent.name) : t('Session actions'), style: place, 'data-leaving': leaving || undefined },
    groups.map((group, index) => h(Fragment, { key: index },
      index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      group.map(([label, Icon, run, danger, checked]) => h('button', {
        key: label, type: 'button', role: 'menuitem', className: danger ? 'bt-danger' : undefined,
        onClick: () => { actions.closeMenu(); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
      }, h(Icon), h('span', { className: 'bt-menu-label' }, label), checked ? h('span', { className: 'bt-menu-check' }, h(CheckIcon)) : null)))))
}
