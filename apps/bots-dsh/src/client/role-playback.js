import { useEffect, useRef, useState } from 'react'
import { speakWith } from './voice-settings.js'

export const spokenLanguage = text => /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'

// One mounted pane owns its lease and its playback queue. The wait first offers
// an id. Only an idle, unpaused pane claims the text, so the host can still
// cancel an offer while another utterance is playing.
export function useRolePlayback({ sessionId, actions, paused, closing, afterSpeech }) {
  const connection = useRef()
  const playing = useRef()
  const pausedNow = useRef(paused)
  pausedNow.current = paused
  const [offer, setOffer] = useState()
  const [caption, setCaption] = useState('')
  const pump = useRef(afterSpeech)
  pump.current = afterSpeech

  useEffect(() => {
    if (!sessionId || !actions.voicePane || !actions.voiceWait || !actions.voiceSpoken || !globalThis.crypto?.randomUUID) return
    const id = globalThis.crypto.randomUUID()
    const controller = new AbortController()
    const { signal } = controller
    const seen = new Set()
    let retry
    let reading = false
    const close = () => {
      if (signal.aborted) return
      controller.abort()
      clearTimeout(retry)
      clearInterval(lease)
      window.removeEventListener('focus', focus)
      window.removeEventListener('pagehide', close)
      if (connection.current?.id === id) connection.current = undefined
      if (playing.current?.id === id) playing.current.finish('closed')
      void actions.voicePane(sessionId, id, false).catch(() => {})
    }
    const read = async () => {
      if (signal.aborted || reading) return
      clearTimeout(retry)
      reading = true
      let next
      try { next = await actions.voiceWait(sessionId, id, undefined, signal) } catch { /* lease retry below */ }
      if (signal.aborted) return
      if (!next || seen.has(next.callId)) {
        reading = false
        retry = setTimeout(read, 350)
        return
      }
      seen.add(next.callId)
      if (seen.size > 128) seen.delete(seen.values().next().value)
      setOffer({ ...next, id, signal })
      // One outstanding offer per pane. The next long poll starts at settlement.
    }
    const renew = async active => {
      if (signal.aborted) return
      const open = await actions.voicePane(sessionId, id, true, active).catch(() => false)
      if (!open) return
      if (signal.aborted) await actions.voicePane(sessionId, id, false).catch(() => {})
      else void read()
    }
    const focus = () => { void renew(true) }
    connection.current = { id, close, resume: () => { reading = false; void read() } }
    const lease = setInterval(() => { void renew(false) }, 10_000)
    window.addEventListener('focus', focus)
    window.addEventListener('pagehide', close)
    void renew(true)
    return close
  }, [sessionId, actions.voicePane, actions.voiceWait, actions.voiceSpoken])

  // A closing reply may already be playing while the offer waits. Its onend
  // calls wake; a pause simply lets the offer wait until resume or expiry.
  const [wake, setWake] = useState(0)
  const notify = () => setWake(value => value + 1)
  useEffect(() => {
    if (!offer || paused || closing.current || playing.current || offer.signal.aborted
      || connection.current?.id !== offer.id) return
    const { callId, id, signal } = offer
    setOffer(undefined)
    const inFlight = { id }
    playing.current = inFlight
    let finished = false
    let answered = false
    const ack = outcome => {
      if (answered) return
      answered = true
      void actions.voiceSpoken(sessionId, id, callId, outcome).catch(() => {})
    }
    inFlight.finish = outcome => {
      if (finished) return
      finished = true
      ack(outcome)
      if (playing.current === inFlight) playing.current = undefined
      setCaption('')
      if (connection.current?.id === id) {
        pump.current()
        connection.current.resume()
      }
    }
    const play = async () => {
      if (offer.expires <= Date.now()) return inFlight.finish('cancelled')
      const synth = window.speechSynthesis
      if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return inFlight.finish('unavailable')
      try {
        const voice = await actions.voiceWait(sessionId, id, callId, signal)
        if (finished || signal.aborted) return
        if (!voice || voice.expires <= Date.now() || pausedNow.current) return inFlight.finish('cancelled')
        const utterance = speakWith(voice.text, spokenLanguage(voice.text), { voice: voice.voice, rate: voice.rate }, synth)
        utterance.onstart = () => { if (!finished) ack('spoken') }
        utterance.onend = () => inFlight.finish('spoken')
        utterance.onerror = () => inFlight.finish('unavailable')
        setCaption(voice.text)
        synth.speak(utterance)
      } catch { inFlight.finish('unavailable') }
    }
    void play()
  }, [offer, paused, wake, sessionId])

  return {
    paneId: () => connection.current?.id,
    busy: () => Boolean(playing.current),
    close: () => connection.current?.close(),
    pause: () => playing.current?.finish('cancelled'),
    notify,
    caption,
  }
}
