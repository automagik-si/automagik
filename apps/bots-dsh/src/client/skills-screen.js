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

function SkillForm({ item, actions, onClose, saved, readOnly }) {
  const [draft, setDraft] = useState(() => ({
    name: item?.name ?? '', description: item?.description ?? '', content: item?.content ?? '',
    source: item?.source?.kind ?? 'text', fileName: item?.source?.fileName,
  }))
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState(null)
  const [error, setError] = useState('')
  const fileInput = useRef(null)
  const set = (key, value) => {
    setDraft(current => ({ ...current, [key]: value }))
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
      setDraft(current => ({ ...current, source: 'file', fileName: file.name, fileBytes }))
      setWarning(null)
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false) }
  }
  const submit = async event => {
    event.preventDefault()
    if (disabled) return
    setBusy(true)
    setError('')
    try {
      const result = await actions.saveSkill({ ...draft, name: draft.name.trim(), edit: !!item,
        ...(warning ? { confirm: warning.needsConfirm } : {}) })
      if (result.needsConfirm) setWarning(result)
      else await saved()
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false) }
  }
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h(Field, { label: t('Name'), value: draft.name, disabled: disabled || !!item, maxLength: 32, onChange: value => set('name', value) }),
    h(Field, { label: t('One-line description'), value: draft.description, disabled, maxLength: 200, onChange: value => set('description', value) }),
    h('div', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'text', onClick: () => {
          setDraft(current => ({ ...current, source: 'text', fileName: undefined, fileBytes: undefined }))
          setWarning(null)
        } }, t('From text')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'file', onClick: () => fileInput.current?.click() }, t('From file')),
      h('input', { ref: fileInput, type: 'file', accept: '.md,.markdown,.txt', hidden: true, disabled, onChange: choose }),
      draft.source === 'file' ? h('span', { className: 'bt-set-hint' }, draft.fileName) : null),
    draft.fileBytes === undefined ? h(Field, { label: t('Skill instructions'), value: draft.content, disabled,
      multiline: true, onChange: value => set('content', value) }) : null,
    warning ? h('div', { className: 'bt-set-row bt-bs-stack', role: 'status' },
      t('Review the warnings, then save again to confirm.'),
      h('ul', null, warning.findings.map(({ rule, line, reason }, index) =>
        h('li', { key: `${rule}:${index}` }, `${hostText(reason)}${line ? ` · ${line}` : ''}`)))) : null,
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
  const change = async action => {
    setBusy(true)
    setError('')
    try { await action() } catch (failure) { setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const disabled = readOnly || busy
  return h('main', { className: 'bt-drawer-body' },
    h('header', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Back'), onClick: onBack }, h(ChevronLeftIcon)),
      h('h1', { className: 'bt-section-title' }, t('Skills')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => setForm({}) }, t('New skill'))),
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    form ? h(SkillForm, { key: form.item?.name ?? '', item: form.item, actions, readOnly,
      onClose: () => setForm(null), saved: async () => { setForm(null); await refresh() } }) : null,
    library.skills.length ? h('div', { className: 'bt-set-card' }, library.skills.map(skill => {
      const result = skill.held ? hostText(skill.held) : skill.check?.verdict === 'warn' ? t('Warnings') : t('Verified')
      const checked = skill.check?.ranAt ? t('Checked {time}', { time: new Date(skill.check.ranAt).toLocaleString() }) : null
      return h('div', { key: skill.name, className: 'bt-connector bt-connector-head' },
        h('span', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-name' }, skill.name),
          h('span', { className: 'bt-connector-status' }, [skill.description, skill.source?.kind === 'file' ? t('From file') : t('From text'), result, checked].filter(Boolean).join(' · '))),
        h('span', { className: 'bt-connector-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => void change(async () => setForm({ item: await actions.getSkill(skill.name) })) }, t('Edit')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => {
            if (confirmDelete !== skill.name) return setConfirmDelete(skill.name)
            void change(async () => { await actions.deleteSkill(skill.name); setConfirmDelete(null); await refresh() })
          } }, confirmDelete === skill.name ? t('Click again to delete.') : t('Delete'))))
    })) : h('p', { className: 'bt-set-hint' }, t('No skills yet.')))
}
