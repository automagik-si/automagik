import { createElement as h, useEffect, useRef, useState } from 'react'
import { modelOf } from './model-menu.js'
import { t } from './i18n.js'

// A Bot's chat that runs on another model than the Bot's saved one (a fallback or any other
// switch inside the Session) says so in a short line above the composer while it lasts. The
// line's arrival is the event: it enters once when the switch happens on screen, and a live
// region that is already there reads it out.

// The Bot whose current part this chat is, when its model is the Bot's (not its plugin's).
const botOf = (roster, sessionId) => {
  const bot = roster?.byId?.[sessionId]
  if (!bot || sessionId !== bot.sessionId || roster.hostModels?.[bot.id] !== undefined) return undefined
  return bot
}

export function modelSwitchOf(roster, sessionId) {
  const bot = botOf(roster, sessionId)
  const savedRef = bot?.model ?? bot?.appliedModel
  if (savedRef === undefined || typeof bot.runningModel !== 'string' || bot.runningModel === savedRef) return undefined
  const running = modelOf({ model: bot.runningModel }, roster)
  const saved = modelOf(bot, roster)
  // The names the composer's model selector shows (model-menu.js modelOf). Two connections
  // can serve models of one name: then each name carries its connection.
  let runningName = running?.name || bot.runningModel
  let savedName = saved?.name || savedRef
  if (runningName === savedName && running?.provider && saved?.provider && running.provider !== saved.provider) {
    runningName = `${runningName} (${running.provider})`
    savedName = `${savedName} (${saved.provider})`
  }
  return { key: `${bot.id}|${bot.runningModel}|${savedRef}`, running: runningName, saved: savedName }
}

// Whether a new reading of a Bot's chat is a switch seen on screen. `key` is the mismatch's
// key, or undefined when the chat runs on the saved model. The first reading, and the first
// one for another Bot, only take note.
export function switchSeen(memo, botId, key) {
  return {
    memo: { botId, key },
    fresh: memo !== undefined && memo.botId === botId && key !== undefined && key !== memo.key,
  }
}

export function ModelSwitchNotice({ sessionId, useRoster }) {
  const roster = useRoster(value => value)
  const bot = botOf(roster, sessionId)
  const mismatch = modelSwitchOf(roster, sessionId)
  const key = mismatch?.key
  // A reading with no running model says nothing (no live Session yet, or the host could not
  // read it), so it neither ends a mismatch nor starts one.
  const known = typeof bot?.runningModel === 'string'
  const memo = useRef()
  const [pulse, setPulse] = useState(0)
  const [fresh, setFresh] = useState(false)
  const [said, setSaid] = useState('')
  const line = mismatch === undefined ? '' : t('This chat is running on {running} instead of {saved}.', { running: mismatch.running, saved: mismatch.saved })
  useEffect(() => {
    if (!known) return
    const next = switchSeen(memo.current, bot.id, key)
    memo.current = next.memo
    if (next.fresh) {
      setPulse(value => value + 1)
      setFresh(true)
      setSaid(line)
    } else if (key === undefined) setSaid('')
  }, [bot?.id, key, known])
  if (bot === undefined) return null
  return h('div', { className: 'bt-model-switch-dock' },
    h('span', { className: 'bt-sr', role: 'status', 'aria-live': 'polite' }, said),
    mismatch === undefined ? null
      : h('div', {
        key: pulse,
        className: 'bt-native-note bt-model-switch',
        'data-fresh': fresh ? '' : undefined,
        onAnimationEnd: () => setFresh(false),
      }, h('p', null, line)))
}

// The line sits on the composer card's axis like the Bot's other docks (suggestions, questions).
// The entrance reuses the secret card's keyframes (secret-card.js SECRET_CSS, installed with the shell).
export const MODEL_SWITCH_CSS = `
.bt-model-switch{justify-content:center;text-align:center;padding:0 4px 6px}
body:not([data-bt-motion=quiet]) .bt-model-switch[data-fresh]{animation:bt-secret-in .24s ease-out}
@media (prefers-reduced-motion:reduce){.bt-model-switch[data-fresh]{animation:none}}
`
