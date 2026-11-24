// New Solver (RFC 0048, delivery 1): a dialog that makes an ordinary Bot set up to solve a request
// end to end, with a reviewer on another model or a fresh-session review, and native tools as
// the person's own tick. Nothing exists until Create; what Create makes is said, and what a
// failure leaves behind is named (solver-draft.js createSolver).
import { createElement as h, useEffect, useState } from 'react'
import { BotMark } from './mark.js'
import { FolderMenu } from './folder-menu.js'
import { ModelMenu } from './model-menu.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { freshBotName } from './bot-draft.js'
import { addStrings, hostText, t } from './i18n.js'
import { presetName } from './permission-picker.js'
import { nameProblem } from '../shared/mentions.js'
import { nativeSwitchView, nativeToolsCopy, nativeToolsZh } from './native-tools-copy.js'
import {
  SOLVER_LOOKS, createSolver, isHermesRemote, reviewerChoices, reviewerModels, reviewerName,
  reviewerPayload, solverCandidate, solverLook, solverPayload, solverStartModel, uncertain,
} from './solver-draft.js'
import { DEFAULT_COLORS, DEFAULT_SHAPES } from './characters.js'

addStrings(nativeToolsZh)

const pick = list => list[Math.floor(Math.random() * list.length)]

export function NewSolver({ roster, actions, brief = '', sectionId = null, onBack, canGoBack = false, onCreated }) {
  const [look, setLook] = useState(() => solverLook())
  const [name, setName] = useState('')
  const [model, setModel] = useState(() => solverStartModel(roster))
  const [effort, setEffort] = useState(undefined)
  const [folder, setFolder] = useState('')
  const [choiceKey, setChoiceKey] = useState(null)
  const [reviewerModel, setReviewerModel] = useState(null)
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState([])
  const [made, setMade] = useState(null)
  useEscape(onBack)
  // A pet in the character slot is worn only when this computer lists it.
  useEffect(() => {
    if (!SOLVER_LOOKS.some(entry => entry?.pet)) return undefined
    let active = true
    Promise.resolve(actions.pets?.()).then(pets => { if (active) setLook(solverLook({ pets })) }, () => {})
    return () => { active = false }
  }, [])
  const run = promise => Promise.resolve(promise).catch(failure => setError(failure?.message ?? String(failure)))
  const fallbackName = freshBotName(roster, t('Solver'))
  const finalName = name.trim() || fallbackName
  const clash = roster.bots.some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const problem = nameProblem(finalName)
  const choices = reviewerChoices(roster, model)
  const choice = choices.find(entry => entry.key === choiceKey) ?? choices[0]
  const otherModels = reviewerModels(roster, model)
  const newModel = choice.kind === 'new' && reviewerModel !== null && otherModels.some(entry => entry.ref === reviewerModel) ? reviewerModel : choice.model
  // The tick is the Details switch of the Solver once made: one function for both.
  // A locked or absent switch never keeps a tick; the hint follows the tick as Details does.
  const unticked = model ? nativeSwitchView(solverCandidate(roster, model, false), roster) : null
  const native = ticked && unticked !== null && !unticked.disabled
  const shownView = native ? nativeSwitchView(solverCandidate(roster, model, true), roster) : unticked
  const hermes = isHermesRemote(model) || (choice.kind === 'new' && isHermesRemote(newModel))
  const permission = roster.newBotPermission ?? roster.prefs?.permission ?? roster.permissions?.defaultPreset
  const blocked = busy || made !== null || clash || Boolean(problem) || !model || Boolean(roster.readOnly) || hermes
  const create = async () => {
    if (blocked) return
    setError('')
    setNotes([])
    setBusy(true)
    const before = new Set(roster.bots.map(bot => bot.id))
    const workDir = folder || undefined
    const reviewer = choice.kind === 'new' ? { kind: 'new' } : choice.kind === 'bot' ? { kind: 'bot', name: choice.name, botId: choice.botId } : { kind: 'fresh' }
    const result = await createSolver({
      actions, before, reviewer, native,
      reviewerPayload: choice.kind === 'new' ? reviewerPayload({
        name: reviewerName(roster, finalName), look: { shape: pick(DEFAULT_SHAPES), color: pick(DEFAULT_COLORS) }, model: newModel, workDir,
      }) : undefined,
      solverPayloadFor: ({ reviewer: reviewerBot, dedicated, reviewerId }) => solverPayload({
        name: finalName, look, model, effort, workDir, brief, sectionId, reviewer: reviewerBot, dedicated, reviewerId, native,
      }),
    })
    setBusy(false)
    if (result.solver && !result.sendError) { onCreated(result.solver); return }
    if (result.solver) {
      setMade(result.solver)
      // A send that was not refused may still have reached the host: never say it was not sent.
      const sent = { name: result.solver.name, error: result.sendError?.message ?? String(result.sendError) }
      setError(uncertain(result.sendError)
        ? t('{name} was created, but your request may not have been sent: {error}', sent)
        : t('{name} was created, but your request was not sent: {error}', sent))
      return
    }
    const text = result.error?.message ?? String(result.error)
    setError(!result.nothing ? text
      : result.step === 3 ? t('Native tools could not be turned on, so nothing was created: {error}', { error: text })
        : t('Nothing was created: {error}', { error: text }))
    setNotes([
      ...result.unremoved.map(bot => t('{name} could not be removed after the failure. Delete it in its Details.', { name: bot })),
      ...result.maybe.map(bot => t('{name} may have been created. Check the sidebar and delete it in its Details if you do not want it.', { name: bot })),
    ])
  }
  const reviewerNote = choice.kind === 'fresh'
    ? [choices.length === 1 ? t('No other model is set up, so reviews run in a fresh session.') : null,
        t('Each review runs in a fresh session that sees only your request and the result. The delivery says so.')].filter(Boolean).join(' ')
    : t('Another Bot on a different model or agent reviews its plan and its result.')
  const tickHint = shownView === null ? '' : shownView.hint.map(key => t(key)).join(' ')
  const worksWithout = shownView !== null && !shownView.disabled && ['acp-claude', 'acp-codex'].includes(shownView.mark)
  return h('div', { className: 'bt-create', role: 'dialog', 'aria-label': t('New Solver') },
    h('div', { className: 'bt-create-head' },
      canGoBack ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to new chat'), onClick: onBack }, h(ChevronLeftIcon)) : h('span', { className: 'bt-create-gap' }),
      h('span', { className: 'bt-create-title' }, t('New Solver')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeOverlay() }, h(CloseIcon))),
    h('div', { className: 'bt-create-body' },
      h('div', { className: 'bt-create-card' },
        h('div', { className: 'bt-create-preview' },
          h('span', { className: 'bt-create-pop' }, h(BotMark, { look, bot: { id: 'new-solver' }, size: 88, live: true, gaze: true, pokeable: true })),
          h('span', { className: 'bt-create-name' }, finalName)),
        h('label', { className: 'bt-field' },
          h('span', { className: 'bt-field-label' }, t('Name')),
          h('input', {
            className: 'bt-input', autoFocus: true, value: name, placeholder: fallbackName, maxLength: 40, 'aria-label': t('Name'),
            onChange: event => setName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create() } },
          }),
          problem ? h('span', { className: 'bt-note bt-danger' }, hostText(problem))
            : clash ? h('span', { className: 'bt-note bt-danger' }, t('A Bot named {name} already exists', { name: finalName })) : null),
        h('div', { className: 'bt-field' },
          h('span', { className: 'bt-field-label' }, t('Model')),
          h(ModelMenu, { bot: { id: 'new-bot', name: finalName, model: model || undefined, effort }, roster, actions, wide: true, onPick: (ref) => { setModel(ref); setEffort(undefined) }, onPickEffort: picked => setEffort(picked ?? null) }),
          isHermesRemote(model) ? h('span', { className: 'bt-note bt-danger' }, t("This model uses its Hermes profile's own instructions.")) : null),
        h('div', { className: 'bt-field' },
          h('span', { className: 'bt-field-label' }, t('Project folder')),
          h(FolderMenu, { value: folder || undefined, actions, run, onPick: (path) => { setError(''); setFolder(path) }, wide: true })),
        h('div', { className: 'bt-field' },
          h('span', { className: 'bt-field-label' }, t('Reviewer')),
          h('select', {
            className: 'bt-select', value: choice.key, 'aria-label': t('Reviewer'),
            onChange: (event) => { setChoiceKey(event.target.value); setReviewerModel(null) },
          }, choices.map(entry => h('option', { key: entry.key, value: entry.key },
            entry.kind === 'new' ? t('New reviewer on another model') : entry.kind === 'bot' ? entry.name : t('Fresh session')))),
          choice.kind === 'new' ? h(ModelMenu, {
            bot: { id: 'new-reviewer', name: reviewerName(roster, finalName), model: newModel }, roster, actions, wide: true, withEfforts: false,
            // The reviewer is another model: the Solver's own is not a pick. It has no level of its own.
            onPick: (ref) => { if (ref !== model) setReviewerModel(ref) },
          }) : null,
          choice.kind === 'new' && isHermesRemote(newModel) ? h('span', { className: 'bt-note bt-danger' }, t("This model uses its Hermes profile's own instructions.")) : null,
          h('span', { className: 'bt-note' }, reviewerNote)),
        shownView === null ? null : h('div', { className: 'bt-field' },
          h('label', { className: 'bt-field-label' },
            h('input', {
              type: 'checkbox', checked: native, disabled: shownView.disabled || busy,
              'aria-label': t(nativeToolsCopy.label),
              onChange: event => setTicked(event.target.checked),
            }), ' ', t(nativeToolsCopy.label)),
          h('span', { className: 'bt-note' }, tickHint),
          worksWithout ? h('span', { className: 'bt-note' }, t('Off by default. The Solver also works without them, with its reviewer.')) : null),
        permission == null ? null : h('div', { className: 'bt-note' },
          t('New Bots start at {level}.', { level: presetName(permission, roster.permissions) })),
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
        notes.map(note => h('div', { key: note, className: 'bt-note bt-danger', role: 'status' }, note)),
        h('div', { className: 'bt-create-foot' },
          h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, canGoBack ? t('Back') : t('Cancel')),
          made !== null
            ? h('button', { type: 'button', className: 'bt-send bt-create-go', onClick: () => onCreated(made) }, t('Done'))
            : h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: blocked, onClick: () => void create() }, busy ? t('Creating…') : t('Create'))))))
}
