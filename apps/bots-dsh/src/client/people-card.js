import * as PeopleReact from 'react'
import { call } from './api.js'
import { Card, Row } from './bot-settings.js'
import { t } from './i18n.js'
import { Segmented } from './motion.js'
import { availablePeople, personKey, personLabels } from './people-model.js'
import { isMainOf } from './sources.js'
import { relativeShort } from './text.js'
import { mountedViewer } from './viewer.js'

const { createElement: h, useEffect, useRef, useState } = PeopleReact
const modes = [
  ['owners', 'Only you and admins'],
  ['allowlist', 'People you choose'],
  ['workspace', 'Anyone in the workspace'],
]
const shareNotes = {
  opening: 'Starting a new part of this chat for sharing…',
  open: 'Shared: people you add read this chat from its new part on.',
  spoiled: 'Sharing did not start because something moved into the new part; stop sharing and share again.',
}
const stale = 'Who may talk to this Bot changed in another window; check it and save again.'
const roleWord = role => role === 'member' ? t('Member') : t('Guest')

export function PeopleCard({ bot, roster }) {
  const role = mountedViewer()?.role
  return role === 'owner' || role === 'admin'
    ? h(OwnerPeopleCard, { key: bot.id, id: bot.id, main: isMainOf(roster, bot.id) }) : null
}

function OwnerPeopleCard({ id, main }) {
  const [seen, setSeen] = useState(null)
  const [share, setShare] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const lifetime = useRef(null)
  const busy = useRef(false)
  const readShare = signal => call('people-share', { id }, signal).then(value => {
    if (!signal.aborted) setShare(value)
  })
  useEffect(() => {
    const scope = new AbortController()
    lifetime.current = scope
    void Promise.all([call('people-seen', undefined, scope.signal), call('people-share', { id }, scope.signal)]).then(([people, value]) => {
      if (!scope.signal.aborted) { setSeen(people); setShare(value) }
    }, () => {})
    return () => scope.abort()
  }, [id])
  useEffect(() => {
    if (saving || share?.state !== 'opening') return
    const scope = new AbortController()
    const timer = setTimeout(() => {
      void readShare(scope.signal).catch(failure => {
        if (!scope.signal.aborted) {
          setError(failure.message)
          setShare(value => ({ ...value }))
        }
      })
    }, 3_000)
    return () => { scope.abort(); clearTimeout(timer) }
  }, [id, share, saving])

  if (!seen || !share) return null
  const { people } = share
  async function save(next) {
    const signal = lifetime.current.signal
    if (busy.current || signal.aborted) return
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await call('update-bot', { id, people: next, expect: people }, signal)
      if (!signal.aborted) setShare(value => ({ ...value, people: result.people }))
    } catch (failure) {
      if (!signal.aborted) setError(failure.code === 'bot/stale' ? t(stale) : failure.message)
    } finally {
      try { if (!signal.aborted) await readShare(signal) } catch { /* Keep the last committed value. */ }
      busy.current = false
      if (!signal.aborted) setSaving(false)
    }
  }

  const title = t('Who can talk to this Bot')
  const choices = availablePeople(seen, people.allow)
  const labels = personLabels([...people.allow, ...choices])
  const seenById = new Map(seen.map(person => [personKey(person), person.lastSeen]))
  return h(Card, { title },
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-hint' }, t('Sharing starts a new part of this chat; earlier parts stay yours.')),
      h(Segmented, { label: title, value: people.mode }, modes.filter(([mode]) => !main || mode !== 'workspace').map(([mode, label]) =>
        h('button', {
          key: mode, type: 'button', 'aria-pressed': people.mode === mode, disabled: saving,
          onClick: () => { if (people.mode !== mode) void save({ ...people, mode }) },
        }, t(label))))),
    h('div', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-hint' },
      t("People you add can read this Bot's chat; they can't send messages yet."))),
    people.mode !== 'owners' ? h('div', null,
      h(Row, { label: t('Guests and named people'), stack: true,
        hint: seen.length === 0 ? t('No one has signed in since the last restart.') : null },
        choices.length > 0 ? h('select', {
          className: 'bt-soft', 'aria-label': t('Add person'), disabled: saving, value: '',
          onChange: event => {
            const person = choices.find(entry => personKey(entry) === event.target.value)
            if (person) void save({ ...people, allow: [...people.allow, person] })
          },
        }, h('option', { value: '' }, t('Add person')), choices.map(person =>
          h('option', { key: personKey(person), value: personKey(person) }, labels.get(personKey(person)) + ' · ' + roleWord(person.role))))
          : null),
      people.allow.map(person => {
        const key = personKey(person)
        const lastSeen = seenById.get(key)
        return h('div', { key, className: 'bt-set-row bt-bs-row' },
          h('span', { className: 'bt-set-copy' }, labels.get(key) + ' · ' + roleWord(person.role),
            h('span', { className: 'bt-set-hint' }, Number.isFinite(lastSeen)
              ? t('Last seen {time}', { time: relativeShort(lastSeen) }) : t('Not signed in since the last restart'))),
          h('button', { type: 'button', className: 'bt-soft', disabled: saving,
            onClick: () => void save({ ...people, allow: people.allow.filter(entry => personKey(entry) !== key) }),
          }, t('Remove')))
      })) : null,
    Object.hasOwn(shareNotes, share.state) ? h('p', { className: 'bt-set-hint', role: 'status' }, t(shareNotes[share.state])) : null,
    error ? h('p', { className: 'bt-set-hint', role: 'alert' }, error) : null)
}
