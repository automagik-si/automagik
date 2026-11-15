import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Voice chat's settings, in General: the microphone (its permission, asked here on a click
// rather than mid-chat), who hears you (DSH's Voice Input plugin, on this computer, else the
// browser's own recognizer), and the voice and speed answers are read in (the system's own
// voices, local). The voice and speed are this browser's: localStorage, read by voice.js.

const VOICE_KEY = 'bt-voice'

/** The voice and speed saved here: { voice: voiceURI | '', rate }. */
export function voicePrefs(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(VOICE_KEY) ?? '{}')
    const rate = Number(saved?.rate)
    return { voice: typeof saved?.voice === 'string' ? saved.voice : '', rate: rate >= 0.5 && rate <= 2 ? rate : 1 }
  } catch {
    return { voice: '', rate: 1 }
  }
}
const saveVoicePrefs = (prefs) => { try { localStorage.setItem(VOICE_KEY, JSON.stringify(prefs)) } catch { /* storage unavailable */ } }

/** An utterance read with the saved voice and speed; the language picks a voice when none is saved. */
export function speakWith(text, lang, synth = globalThis.speechSynthesis) {
  const utterance = new SpeechSynthesisUtterance(text)
  const { voice, rate } = voicePrefs()
  const chosen = voice ? synth?.getVoices?.().find(entry => entry.voiceURI === voice) : undefined
  if (chosen) utterance.voice = chosen
  utterance.lang = chosen?.lang ?? lang
  utterance.rate = rate
  return utterance
}

function useVoices() {
  const [voices, setVoices] = useState(() => globalThis.speechSynthesis?.getVoices?.() ?? [])
  useEffect(() => {
    const synth = globalThis.speechSynthesis
    if (!synth) return undefined
    const load = () => setVoices(synth.getVoices())
    synth.addEventListener?.('voiceschanged', load)
    load()
    return () => synth.removeEventListener?.('voiceschanged', load)
  }, [])
  return voices
}

function useMicrophone() {
  const [state, setState] = useState('unknown')
  useEffect(() => {
    let status
    void navigator.permissions?.query({ name: 'microphone' }).then((result) => {
      status = result
      setState(result.state)
      result.onchange = () => setState(result.state)
    }, () => {})
    return () => { if (status) status.onchange = null }
  }, [])
  const ask = () => navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
    for (const track of stream.getTracks()) track.stop()
    setState('granted')
  }, () => setState('denied'))
  return [state, ask]
}

export function VoiceSection({ actions, Section, Row }) {
  const voices = useVoices()
  const [mic, askMic] = useMicrophone()
  const [prefs, setPrefs] = useState(voicePrefs)
  const local = actions.speech() !== undefined
  const setup = actions.voiceSetup()
  const update = (patch) => { const next = { ...prefs, ...patch }; setPrefs(next); saveVoicePrefs(next) }
  const test = () => {
    const synth = globalThis.speechSynthesis
    if (!synth) return
    synth.cancel()
    synth.speak(speakWith(t('Hi, this is how I sound in voice chat.'), 'en-US'))
  }
  const micText = { granted: t('Allowed'), denied: t('Blocked'), prompt: t('Not asked yet'), unknown: t('Not asked yet') }[mic] ?? t('Not asked yet')
  return h(Section, { title: t('Voice chat') },
    h(Row, { label: t('Microphone'), hint: mic === 'denied' ? t('Allow Automagik in your system settings (Privacy & Security → Microphone), then try again.') : t('Used only while a voice chat listens.') },
      h('span', { className: 'bt-voice-set' },
        h('span', { className: 'bt-set-hint' }, micText),
        mic === 'granted' ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void askMic() } }, t('Allow microphone')))),
    h(Row, { label: t('Hears you'), hint: local ? t('DSH\'s Voice Input recognizes your speech on this computer.') : t('Turn on DSH\'s Voice Input plugin to recognize speech on this computer; without it voice chat needs the browser\'s own recognizer.') },
      local ? h('span', { className: 'bt-set-hint' }, t('On this computer'))
        : setup?.navigate ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: setup.navigate }, t('Turn on Voice Input')) : null),
    h(Row, { label: t('Voice'), hint: t('The voices your system has, read on this computer.') },
      h('span', { className: 'bt-voice-set' },
        h('select', { className: 'bt-input', value: prefs.voice, 'aria-label': t('Voice'), onChange: event => update({ voice: event.target.value }) },
          h('option', { value: '' }, t('Automatic, by language')),
          voices.map(voice => h('option', { key: voice.voiceURI, value: voice.voiceURI }, `${voice.name} (${voice.lang})`))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: test }, t('Try it')))),
    h(Row, { label: t('Speed') },
      h('span', { className: 'bt-voice-set' },
        h('input', { type: 'range', min: 0.6, max: 1.6, step: 0.1, value: prefs.rate, 'aria-label': t('Speed'), onChange: event => update({ rate: Number(event.target.value) }) }),
        h('span', { className: 'bt-set-hint' }, `${prefs.rate.toFixed(1)}×`))))
}

export const VOICE_SETTINGS_CSS = `
.bt-voice-set{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.bt-voice-set select{max-width:240px}
`
