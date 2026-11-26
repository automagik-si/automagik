import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronLeftIcon } from './icons.js'
import { hostText, t } from './i18n.js'
import { bootView, isRetired, mountedViewer } from './viewer.js'

export const SKILLS_PANEL = 'automagik-skills'

export function canManageSkills() {
  if (isRetired()) return false
  const role = mountedViewer()?.role ?? bootView()?.role ?? 'owner'
  return role === 'owner' || role === 'admin'
}

const EMPTY = { skills: [], active: {} }
export function useSkillLibrary(actions) {
  const [library, setLibrary] = useState(EMPTY)
  const [error, setError] = useState('')
  const refresh = async signal => {
    try {
      const result = await actions.skillLibrary(signal)
      if (!signal?.aborted && Array.isArray(result?.skills) && result.active) setLibrary(result)
    } catch (failure) {
      if (!signal?.aborted) setError(hostText(failure.message))
    }
  }
  useEffect(() => {
    if (typeof actions?.skillLibrary !== 'function') return
    const controller = new window.AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [actions])
  return { library, error, setError, refresh }
}

function Field({ label, value, onChange, disabled, maxLength, multiline }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label)),
    h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'bt-input bt-input-area' : 'bt-input', value, disabled, maxLength,
      spellCheck: false, onChange: event => onChange(event.target.value),
    }))
}

export async function skillFileBytes(file) {
  if (file.size > 65_536) throw new Error(t('The skill is over 64 KiB. Shorten it.'))
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > 65_536) throw new Error(t('The skill is over 64 KiB. Shorten it.'))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function SkillReport({ report }) {
  if (!report) return null
  return h('div', { className: 'bt-set-row bt-bs-stack', role: 'status' },
    report.refused
      ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, hostText(report.message))
      : report.needsConfirm ? t('Review the warnings, then save again to confirm.') : t('Warnings'),
    report.truncated ? h('p', { className: 'bt-set-hint' },
      t('Only retained findings are shown. This review cannot be confirmed.')) : null,
    report.findings?.length ? h('ul', null, report.findings.map(({ rule, line, reason, path, file, severity, injection, detail }, index) => {
      const source = path ?? file
      return h('li', { key: `${rule ?? file}:${index}` },
        [injection ? t('Prompt injection') : null, severity ? t(severity) : null, hostText(reason),
          detail, source ? `${source}${line ? `:${line}` : ''}` : line].filter(Boolean).join(' · '))
    })) : null)
}

function SkillForm({ item, initial, actions, onClose, saved, readOnly, report }) {
  const [draft, setDraft] = useState(() => ({
    name: item?.name ?? '', description: item?.description ?? '', content: item?.content ?? '',
    source: item?.source?.kind ?? 'text', fileName: item?.source?.fileName,
    reviewHash: item?.reviewHash, ...initial,
  }))
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [warning, setWarning] = useState(() => report ?? (item?.held && item.check?.verdict === 'warn' ? item.check : null))
  const [error, setError] = useState('')
  const fileInput = useRef(null)
  const set = (key, value) => {
    setDraft(current => ({ ...current, [key]: value, reviewHash: undefined }))
    setWarning(null)
  }
  const disabled = readOnly || busy
  const choose = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setBusy(true)
    try {
      const fileBytes = await skillFileBytes(file)
      setDraft(current => ({ ...current, source: 'file', fileName: file.name, fileBytes, reviewHash: undefined }))
      setWarning(null)
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false) }
  }
  const submit = async event => {
    event.preventDefault()
    if (disabled) return
    setBusy(true)
    setChecking(true)
    setError('')
    try {
      const input = draft.reviewHash === undefined ? draft : { reviewHash: draft.reviewHash }
      const result = await actions.saveSkill({ ...input, name: draft.name.trim(), edit: !!item,
        ...(warning?.needsConfirm ? { confirm: warning.needsConfirm } : {}) })
      if (result.needsConfirm || result.refused) setWarning(result)
      else await saved()
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false); setChecking(false) }
  }
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h(Field, { label: t('Name'), value: draft.name, disabled: disabled || !!item, maxLength: 32, onChange: value => set('name', value) }),
    h(Field, { label: t('One-line description'), value: draft.description, disabled, maxLength: 200, onChange: value => set('description', value) }),
    h('div', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'text', onClick: () => {
          setDraft(current => ({ ...current, source: 'text', fileName: undefined, fileBytes: undefined, reviewHash: undefined }))
          setWarning(null)
        } }, t('From text')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'file', onClick: () => fileInput.current?.click() }, t('From file')),
      h('input', { ref: fileInput, type: 'file', accept: '.md,.markdown,.txt', hidden: true, disabled, onChange: choose }),
      draft.source === 'file' ? h('span', { className: 'bt-set-hint' }, draft.fileName) : null),
    draft.fileBytes === undefined ? h(Field, { label: t('Skill instructions'), value: draft.content, disabled,
      multiline: true, onChange: value => set('content', value) }) : null,
    checking ? h('p', { className: 'bt-set-hint', role: 'status' }, t('Checking the skill…')) : null,
    SkillReport({ report: warning }),
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled }, item ? t('Save changes') : t('Save'))))
}

export function SkillsScreen({ actions, rosterSource, onBack }) {
  const roster = useSyncExternalStore(rosterSource.subscribe, rosterSource.getSnapshot)
  return canManageSkills() ? h(OwnerSkillsScreen, { actions, readOnly: !!roster.readOnly, onBack }) : null
}

function OwnerSkillsScreen({ actions, readOnly, onBack }) {
  const { library, error, setError, refresh } = useSkillLibrary(actions)
  const [form, setForm] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rowReview, setRowReview] = useState(null)
  const [recovered, setRecovered] = useState([])
  const [recovering, setRecovering] = useState(() => Boolean(actions.resumeSkillSaves))
  useEffect(() => {
    if (!actions.resumeSkillSaves) return
    const controller = new window.AbortController()
    const { signal } = controller
    setRecovering(true)
    void (async () => {
      try {
        const results = await actions.resumeSkillSaves(signal)
        const completed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
        const forms = []
        for (const { form: initial, ...report } of completed) {
          if (report.refused) forms.push({ report })
          if (!report.needsConfirm || !initial) continue
          const item = initial.reviewHash !== undefined ? await actions.getSkill(initial.name, signal)
            : initial.edit ? { name: initial.name } : undefined
          if (initial.reviewHash !== undefined && item?.reviewHash !== initial.reviewHash) continue
          forms.push({ initial, item, report })
        }
        if (signal.aborted) return
        setRecovered(forms)
        if (completed.length) await refresh(signal)
        const failed = results.find(result => result.status === 'rejected' && result.reason.code !== 'bot/not-found')
        if (failed && !signal.aborted) setError(hostText(failed.reason.message))
      } catch (failure) {
        if (!signal.aborted) setError(hostText(failure.message))
      } finally {
        if (!signal.aborted) setRecovering(false)
      }
    })()
    return () => controller.abort()
  }, [actions])
  const change = async action => {
    setBusy(true)
    setError('')
    try { await action() } catch (failure) { setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const reviewStored = skill => change(async () => {
    setRowReview({ name: skill.name })
    try {
      const item = await actions.getSkill(skill.name)
      if (item.reviewHash !== skill.reviewHash) { await refresh(); return }
      const result = await actions.saveSkill({ name: skill.name, edit: true, reviewHash: item.reviewHash })
      if (result.needsConfirm) setForm({ item, report: result })
      else if (result.refused) {
        setRowReview({ name: skill.name, report: result })
        await refresh()
      }
      else await refresh()
    } finally {
      setRowReview(current => current?.report ? current : null)
    }
  })
  const disabled = readOnly || busy || recovering
  const activeForm = form ?? recovered.find(entry => entry.initial)
  const closeForm = () => {
    if (form) setForm(null)
    else setRecovered(current => current.filter(entry => entry !== activeForm))
  }
  return h('main', { className: 'bt-drawer-body' },
    h('header', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Back'), onClick: onBack }, h(ChevronLeftIcon)),
      h('h1', { className: 'bt-section-title' }, t('Skills')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => setForm({}) }, t('New skill'))),
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    recovered.filter(entry => !entry.initial).map(({ report }, index) => h(SkillReport, { key: index, report })),
    activeForm ? h(SkillForm, { key: activeForm.initial ? activeForm.report.needsConfirm : activeForm.item?.name ?? '',
      item: activeForm.item, initial: activeForm.initial, report: activeForm.report, actions, readOnly,
      onClose: closeForm, saved: async () => { closeForm(); await refresh() } }) : null,
    library.skills.length ? h('div', { className: 'bt-set-card' }, library.skills.map(skill => {
      const result = skill.held ? hostText(skill.held) : skill.check?.verdict === 'warn' ? t('Warnings') : t('Verified')
      const checked = skill.check?.ranAt ? t('Checked {time}', { time: new Date(skill.check.ranAt).toLocaleString() }) : null
      return h('div', { key: skill.name, className: 'bt-connector bt-connector-head' },
        h('div', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-name' }, skill.name),
          h('span', { className: 'bt-connector-status' }, [skill.description, skill.source?.kind === 'file' ? t('From file') : t('From text'), result,
            skill.review?.status === 'done' ? t('Reviewed by a model') : null, checked].filter(Boolean).join(' · ')),
          rowReview?.name === skill.name ? (rowReview.report ? SkillReport({ report: rowReview.report })
            : h('span', { className: 'bt-set-hint', role: 'status' }, t('Checking the skill…'))) : null),
        h('span', { className: 'bt-connector-actions' },
          skill.reviewHash ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => void reviewStored(skill) }, t('Review skill')) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => void change(async () => setForm({ item: await actions.getSkill(skill.name) })) }, t('Edit')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => {
            if (confirmDelete !== skill.name) return setConfirmDelete(skill.name)
            void change(async () => { await actions.deleteSkill(skill.name); setConfirmDelete(null); await refresh() })
          } }, confirmDelete === skill.name ? t('Click again to delete.') : t('Delete'))))
    })) : h('p', { className: 'bt-set-hint' }, t('No skills yet.')))
}
