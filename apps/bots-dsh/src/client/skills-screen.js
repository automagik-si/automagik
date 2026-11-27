import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronLeftIcon } from './icons.js'
import { hostText, t } from './i18n.js'
import { lineDiff } from './learning-card-model.js'
import { bootView, isRetired, mountedViewer } from './viewer.js'

export const SKILLS_PANEL = 'automagik-skills'
const archiveFile = name => /\.(?:zip|tar\.gz|tgz)$/i.test(name)
const archiveAccept = '.zip,.tar.gz,.tgz'
const treeSkill = item => item?.source?.kind === 'folder' || item?.source?.kind === 'archive'
const viewerRole = () => mountedViewer()?.role ?? bootView()?.role ?? 'owner'
const treeNote = () => t('Scripts and references are stored with this skill but are not yet available to Bots. A Bot receives only the SKILL.md text.')

export function canManageSkills() {
  if (isRetired()) return false
  const role = viewerRole()
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

async function skillArchiveBytes(file) {
  const limit = 6 * 1024 * 1024
  const tooLarge = () => new Error(t('The skill archive is over 6 MiB.'))
  if (file.size > limit) throw tooLarge()
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > limit) throw tooLarge()
  const chunks = []
  const chunkSize = 24_576
  for (let start = 0; start < bytes.length; start += chunkSize) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + chunkSize))))
  }
  return chunks.join('')
}

function SkillReport({ report, title }) {
  if (!report) return null
  return h('div', { className: 'bt-set-row bt-bs-stack', role: 'status' },
    report.refused
      ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, hostText(report.message))
      : title ?? (report.needsConfirm ? t('Review the warnings, then save again to confirm.') : t('Warnings')),
    report.truncated ? h('p', { className: 'bt-set-hint' },
      t('Only retained findings are shown. This review cannot be confirmed.')) : null,
    report.findings?.length ? h('ul', null, report.findings.map(({ rule, line, reason, path, file, severity, injection, detail }, index) => {
      const source = path ?? file
      return h('li', { key: `${rule ?? file}:${index}` },
        [injection ? t('Prompt injection') : null, severity ? t(severity) : null, hostText(reason),
          detail, source ? `${source}${line ? `:${line}` : ''}` : line].filter(Boolean).join(' · '))
    })) : null)
}

function TreeDetails({ view }) {
  const { tree = [], scripts = [], references = [], skipped } = view
  const interpreters = new Map(scripts.map(script => [script.path, script.interpreter]))
  const referencePaths = new Set(references)
  return h('div', { className: 'bt-set-row bt-bs-stack' },
    tree.length ? h('ul', null, tree.map(({ path, size }) => {
      const interpreter = interpreters.get(path)
      return h('li', { key: path },
        h('code', null, path), ' · ', t('{size} bytes', { size }),
        interpreter ? ` · ${interpreter}` : null,
        referencePaths.has(path) ? ` · ${t('Reference file')}` : null)
    })) : null,
    skipped ? h('p', { className: 'bt-set-hint' }, t('Skipped files: {count}', { count: skipped })) : null,
    tree.length > 1 ? h('p', { className: 'bt-set-hint' }, treeNote()) : null)
}

function TreeDiff({ diff }) {
  if (!diff) return null
  const fileGroup = (title, rows, before, after) => rows.length ? h('details', null,
    h('summary', null, `${title} · ${rows.length}`),
    rows.map(row => {
      const left = before(row)
      const right = after(row)
      return h('div', { key: row.path },
        h('code', null, row.path),
        left === undefined || right === undefined
          ? h('p', { className: 'bt-set-hint' }, t('Too large to show line by line.'))
          : h('pre', null, lineDiff(left, right).map(({ kind, line }) =>
            `${kind === 'added' ? '+' : kind === 'removed' ? '-' : ' '} ${line}`).join('\n')))
    })) : null
  return h('div', { className: 'bt-set-row bt-bs-stack' },
    diff.findings.new.length ? h(SkillReport, { title: t('New findings'), report: { findings: diff.findings.new } }) : null,
    diff.findings.gone.length ? h(SkillReport, { title: t('Gone findings'), report: { findings: diff.findings.gone } }) : null,
    diff.held ? h('p', { className: 'bt-set-hint' }, t('The saved version could not be verified; this replaces it.')) : null,
    diff.files ? [
      fileGroup(t('Added files'), diff.files.added, () => '', row => row.text),
      fileGroup(t('Removed files'), diff.files.removed, row => row.text, () => ''),
      fileGroup(t('Changed files'), diff.files.changed, row => row.beforeText, row => row.afterText),
    ] : null)
}

function useTreePreview({ item, preview, actions, saved }) {
  const [view, setView] = useState(preview ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typing, setTyping] = useState(false)
  const [path, setPath] = useState('')
  const run = async task => {
    setError('')
    setBusy(true)
    try { await task() } catch (failure) { setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const request = async input => {
    const result = await actions.saveSkill({ ...input, preview: true, ...(item ? { edit: true, name: item.name } : {}) })
    if (result.expired) { setError(expiredResult(result.kind)); return }
    setView(result)
    setTyping(false)
  }
  return {
    view, busy, error, typing, path, setPath,
    fromFile: file => run(async () => request({ source: 'archive', fileName: file.name, fileBytes: await skillArchiveBytes(file) })),
    fromFolder: () => run(async () => {
      const folders = await actions.folders()
      if (folders?.picker !== 'native') { setTyping(true); return }
      const path = await actions.folderPick()
      if (path) await request({ source: 'folder', path })
    }),
    usePath: () => run(() => request({ source: 'folder', path })),
    fromLink: url => run(() => request({ source: 'link', url })),
    confirmStored: report => run(async () => {
      const result = await actions.saveSkill({ name: item.name, edit: true, reviewHash: item.reviewHash, confirm: report.needsConfirm })
      if (result.expired) setError(expiredResult(result.kind))
      else if (result.refused || result.needsConfirm) setView(result)
      else await saved()
    }),
    save: () => run(async () => {
      const result = await actions.saveSkill({ token: view.token, name: view.name,
        ...(view.needsConfirm ? { confirm: view.needsConfirm } : {}) })
      if (result.expired) { setError(expiredResult(result.kind)); return }
      if (result.refused || result.needsConfirm) setView({ ...view, ...result, ...(result.refused ? { token: undefined } : {}) })
      else await saved()
    }),
  }
}

function FolderPath({ tree, disabled }) {
  return tree.typing ? h('div', { className: 'bt-set-row' },
    h(Field, { label: t('Full path of a folder'), value: tree.path, disabled, onChange: tree.setPath }),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: disabled || !tree.path,
      onClick: tree.usePath }, t('Use this folder'))) : null
}

function TreePreview({ tree, onClose, readOnly }) {
  const { view, busy, error } = tree
  return h('div', { className: 'bt-set-card bt-task-form' },
    h('div', { className: 'bt-set-row bt-bs-stack' },
      h('strong', null, view.name), h('span', { className: 'bt-set-hint' }, view.description)),
    view.source?.kind === 'link' ? h('p', { className: 'bt-set-hint' }, sourceLine(view.source)) : null,
    view.keyNames?.length ? h('p', { className: 'bt-set-hint' }, t('Declared key names'), ' · ', view.keyNames.join(', ')) : null,
    h(TreeDetails, { view }),
    h(TreeDiff, { diff: view.diff }),
    view.refused || view.findings?.length ? h(SkillReport, { report: view }) : null,
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      view.token && !view.refused ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: readOnly || busy,
        onClick: tree.save }, t('Save')) : null))
}

function expiredResult(kind) {
  return kind === 'check' || kind === 'apply'
    ? t('This result is no longer available. Check for update again.')
    : t('This result is no longer available. Save the skill again.')
}

function sourceLine({ host, ref, revision }) {
  return [host, ref, ref === null ? t('Content hash') + ' ' + revision.slice(7, 19) : revision.slice(0, 12)]
    .filter(Boolean).join(' · ')
}

function LinkDetails({ item, report, actions, onClose, saved, readOnly }) {
  const tree = useTreePreview({ item, actions, saved })
  const current = tree.view ?? report
  return h('div', { className: 'bt-set-card bt-task-form' },
    h('strong', null, item.name),
    h('p', { className: 'bt-set-hint' }, sourceLine(item.source)),
    item.held ? h('p', { className: 'bt-set-hint' }, hostText(item.held)) : null,
    !item.held && item.content ? h('pre', { className: 'bt-set-hint' }, item.content) : null,
    current ? h(SkillReport, { report: current }) : null,
    tree.error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, tree.error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      current?.needsConfirm && item.reviewHash ? h('button', { type: 'button', className: 'bt-send bt-soft-sm',
        disabled: readOnly || tree.busy, onClick: () => tree.confirmStored(current) }, t('Save')) : null))
}

function LinkUpdate({ report, actions, onClose, saved, readOnly }) {
  const [view, setView] = useState(report)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const apply = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await actions.saveSkill({ update: 'apply', token: view.token, name: view.name,
        ...(view.needsConfirm ? { confirm: view.needsConfirm } : {}) })
      if (result.saved) await saved()
      else if (result.expired) {
        setError(expiredResult(result.kind ?? 'apply'))
        setView({ ...view, token: undefined })
      } else setView({ ...view, ...result, ...(result.refused ? { token: undefined } : {}) })
    } catch (failure) { setError(hostText(failure.message)) }
    finally { setBusy(false) }
  }
  const use = (label, rows, show) => rows?.length
    ? h('p', { className: 'bt-set-hint' }, t(label), ' · ', rows.map(show).join(', '))
    : null
  return h('div', { className: 'bt-set-card bt-task-form' },
    h('strong', null, view.name),
    view.previousSource && view.source ? h('p', { className: 'bt-set-hint' },
      sourceLine(view.previousSource), ' → ', sourceLine(view.source)) : null,
    use('New endpoints', view.endpoints?.new, entry => entry.origin ?? entry.host),
    use('Removed endpoints', view.endpoints?.gone, entry => entry.origin ?? entry.host),
    use('New scripts', view.scriptChanges?.new, entry => entry.path),
    use('Removed scripts', view.scriptChanges?.gone, entry => entry.path),
    use('New key names', view.keyNames?.new, key => key),
    use('Removed key names', view.keyNames?.gone, key => key),
    view.usedBy?.length ? h('p', { className: 'bt-set-hint' }, t('Used by: {bots}', { bots: view.usedBy.map(bot => bot.name).join(', ') })) : null,
    view.diff?.held ? h('p', { className: 'bt-set-hint' },
      t('The saved version could not be verified; Apply replaces it with the checked new content.')) : null,
    view.diff?.held ? h(TreeDetails, { view }) : null,
    h(TreeDiff, { diff: view.diff?.held ? { ...view.diff, held: false } : view.diff }),
    view.refused || view.findings?.length ? h(SkillReport, { report: view,
      title: view.needsConfirm ? t('Review the warnings, then apply again to confirm.') : undefined }) : null,
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onClose }, t('Cancel')),
      view.token && !view.refused ? h('button', { type: 'button', className: 'bt-send bt-soft-sm',
        disabled: readOnly || busy, onClick: apply }, t('Apply')) : null))
}

function TreeForm({ item, report, preview, actions, onClose, saved, readOnly }) {
  const tree = useTreePreview({ item, preview, actions, saved })
  const input = useRef(null)
  if (tree.view?.preview) return h(TreePreview, { tree, onClose, readOnly })
  const disabled = readOnly || tree.busy
  const current = tree.view ?? report
  return h('div', { className: 'bt-set-card bt-task-form' },
    h('div', { className: 'bt-set-row bt-bs-stack' },
      h('strong', null, item.name), h('span', { className: 'bt-set-hint' }, item.description),
      item.held ? h('p', { className: 'bt-set-hint' }, hostText(item.held)) : null),
    h(TreeDetails, { view: item }),
    current ? h(SkillReport, { report: current }) : null,
    h('div', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        onClick: () => input.current?.click() }, t('Replace from file')),
      viewerRole() === 'owner' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
        disabled, onClick: tree.fromFolder }, t('Replace from folder')) : null,
      h('input', { ref: input, type: 'file', accept: archiveAccept, hidden: true, disabled, onChange: event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) return tree.fromFile(file)
      } })),
    h(FolderPath, { tree, disabled }),
    tree.busy ? h('p', { className: 'bt-set-hint', role: 'status' }, t('Checking the skill…')) : null,
    tree.error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, tree.error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      current?.needsConfirm && item.reviewHash ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled,
        onClick: () => tree.confirmStored(current) }, t('Save')) : null))
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
  const [link, setLink] = useState('')
  const fileInput = useRef(null)
  const tree = useTreePreview({ actions, saved })
  const set = (key, value) => {
    setDraft(current => ({ ...current, [key]: value, reviewHash: undefined }))
    setWarning(null)
  }
  const disabled = readOnly || busy || tree.busy
  const choose = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!item && archiveFile(file.name)) return tree.fromFile(file)
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
      if (result.expired) setError(expiredResult(result.kind))
      else if (result.needsConfirm || result.refused) setWarning(result)
      else await saved()
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false); setChecking(false) }
  }
  if (tree.view) return h(TreePreview, { tree, onClose, readOnly })
  const linking = !item && draft.source === 'link'
  const submitLink = event => {
    event?.preventDefault()
    if (!disabled && link.trim()) return tree.fromLink(link.trim())
  }
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: linking ? submitLink : submit },
    linking ? null : h(Field, { label: t('Name'), value: draft.name, disabled: disabled || !!item, maxLength: 32,
      onChange: value => set('name', value) }),
    linking ? null : h(Field, { label: t('One-line description'), value: draft.description, disabled, maxLength: 200,
      onChange: value => set('description', value) }),
    h('div', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'text', onClick: () => {
          setDraft(current => ({ ...current, source: 'text', fileName: undefined, fileBytes: undefined, reviewHash: undefined }))
          setWarning(null)
        } }, t('From text')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': draft.source === 'file', onClick: () => fileInput.current?.click() }, t('From file')),
      !item && viewerRole() === 'owner' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        onClick: tree.fromFolder }, t('From folder')) : null,
      !item ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
        'aria-pressed': linking, onClick: () => set('source', 'link') }, t('From link')) : null,
      h('input', { ref: fileInput, type: 'file', accept: `.md,.markdown,.txt${item ? '' : ',' + archiveAccept}`, hidden: true, disabled, onChange: choose }),
      draft.source === 'file' ? h('span', { className: 'bt-set-hint' }, draft.fileName) : null),
    h(FolderPath, { tree, disabled }),
    linking ? h(Field, { label: t('Link'), value: link, disabled, maxLength: 2048, onChange: setLink }) : null,
    !linking && draft.fileBytes === undefined ? h(Field, { label: t('Skill instructions'), value: draft.content, disabled,
      multiline: true, onChange: value => set('content', value) }) : null,
    checking || tree.busy ? h('p', { className: 'bt-set-hint', role: 'status' }, t('Checking the skill…')) : null,
    SkillReport({ report: warning }),
    error || tree.error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, tree.error || error) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      linking ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: disabled || !link.trim(),
        onClick: submitLink }, t('Preview'))
        : h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled }, item ? t('Save changes') : t('Save'))))
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
  const [checkedLinks, setCheckedLinks] = useState({})
  const checkingLink = useRef(null)
  const [recovered, setRecovered] = useState([])
  const [recovering, setRecovering] = useState(() => Boolean(actions.resumeSkillSaves))
  const stopCheck = () => checkingLink.current?.abort()
  useEffect(() => stopCheck, [actions])
  const rememberCheck = (name, report) => setCheckedLinks(current => ({ ...current, [name]: report.checkedAt }))
  useEffect(() => {
    if (!actions.resumeSkillSaves) return
    const controller = new window.AbortController()
    const { signal } = controller
    setRecovering(true)
    void (async () => {
      try {
        const results = await actions.resumeSkillSaves(signal)
        if (signal.aborted) return
        const completed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
        const forms = []
        for (const { form: initial, ...report } of completed) {
          if (report.stale) continue
          if (report.expired) { setError(expiredResult(report.kind)); continue }
          if (initial?.kind === 'check' || initial?.kind === 'apply') {
            if (report.upToDate) rememberCheck(initial.target, report)
            else if (!report.saved) forms.push({ update: report })
            continue
          }
          if (report.preview) { forms.push({ preview: report }); continue }
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
      if (result.expired) setError(expiredResult(result.kind))
      else if (result.needsConfirm) setForm({ item, report: result })
      else if (result.refused) {
        setRowReview({ name: skill.name, report: result })
        await refresh()
      }
      else await refresh()
    } finally {
      setRowReview(current => current?.report ? current : null)
    }
  })
  const checkLink = skill => change(async () => {
    const controller = new window.AbortController()
    const { signal } = controller
    checkingLink.current = controller
    setCheckedLinks(current => ({ ...current, [skill.name]: undefined }))
    try {
      const result = await actions.saveSkill({ update: 'check', name: skill.name }, signal)
      if (signal.aborted) return
      if (result.expired) setError(expiredResult(result.kind ?? 'check'))
      else if (result.upToDate) rememberCheck(skill.name, result)
      else setForm({ update: result })
      await refresh(signal)
    } catch (failure) {
      if (!signal.aborted) throw failure
    } finally {
      if (checkingLink.current === controller) checkingLink.current = null
    }
  })
  const disabled = readOnly || busy || recovering
  const activeForm = form ?? recovered.find(entry => entry.initial || entry.preview || entry.update)
  const activeType = activeForm?.update ? LinkUpdate : activeForm?.item?.source?.kind === 'link' ? LinkDetails
    : activeForm?.preview || treeSkill(activeForm?.item) ? TreeForm : SkillForm
  const closeForm = () => {
    stopCheck()
    if (form) setForm(null)
    else setRecovered(current => current.filter(entry => entry !== activeForm))
  }
  return h('main', { className: 'bt-drawer-body' },
    h('header', { className: 'bt-set-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Back'), onClick: () => {
        stopCheck()
        onBack()
      } }, h(ChevronLeftIcon)),
      h('h1', { className: 'bt-section-title' }, t('Skills')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => setForm({}) }, t('New skill'))),
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    recovered.filter(entry => entry.report && !entry.initial).map(({ report }, index) => h(SkillReport, { key: index, report })),
    activeForm ? h(activeType,
      { key: activeForm.update?.token ?? activeForm.update?.hash ?? activeForm.preview?.token ??
        (activeForm.initial ? activeForm.report.needsConfirm : activeForm.item?.name ?? ''),
      item: activeForm.item, initial: activeForm.initial, report: activeForm.update ?? activeForm.report,
      preview: activeForm.preview, actions, readOnly,
      onClose: closeForm, saved: async () => { closeForm(); await refresh() } }) : null,
    library.skills.length ? h('div', { className: 'bt-set-card' }, library.skills.map(skill => {
      const result = skill.held ? hostText(skill.held) : skill.check?.verdict === 'warn' ? t('Warnings') : t('Verified')
      const checked = skill.check?.ranAt ? t('Checked {time}', { time: new Date(skill.check.ranAt).toLocaleString() }) : null
      const linked = skill.source?.kind === 'link'
      const checkedAt = Object.hasOwn(checkedLinks, skill.name) ? checkedLinks[skill.name] : undefined
      return h('div', { key: skill.name, className: 'bt-connector bt-connector-head' },
        h('div', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-name' }, skill.name),
          h('span', { className: 'bt-connector-status' }, [skill.description, t({
            folder: 'From folder', archive: 'From archive', file: 'From file', text: 'From text', link: 'From link',
          }[skill.source?.kind] ?? 'From text'), result,
            skill.scripts?.length ? t('Scripts: {count}', { count: skill.scripts.length }) : null,
            skill.references?.length ? t('References: {count}', { count: skill.references.length }) : null,
            skill.review?.status === 'done' ? t('Reviewed by a model') : null, checked].filter(Boolean).join(' · ')),
          linked ? h('p', { className: 'bt-set-hint' }, sourceLine(skill.source), ' · ',
            t('Fetched {time}', { time: new Date(skill.source.fetchedAt).toLocaleString() })) : null,
          checkedAt !== undefined ? h('p', { className: 'bt-set-hint', role: 'status' },
            t('Up to date · checked {time}', { time: new Date(checkedAt).toLocaleString() })) : null,
          skill.tree?.length > 1 ? h('p', { className: 'bt-set-hint' }, treeNote()) : null,
          rowReview?.name === skill.name ? (rowReview.report ? SkillReport({ report: rowReview.report })
            : h('span', { className: 'bt-set-hint', role: 'status' }, t('Checking the skill…'))) : null),
        h('span', { className: 'bt-connector-actions' },
          skill.reviewHash ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => void reviewStored(skill) }, t('Review skill')) : null,
          skill.checkable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => checkLink(skill) }, t('Check for update')) : null,
          !linked || !skill.held ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
            onClick: () => void change(async () => setForm({ item: await actions.getSkill(skill.name) })) }, t('Edit')) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => {
            if (confirmDelete !== skill.name) return setConfirmDelete(skill.name)
            void change(async () => {
              await actions.deleteSkill(skill.name)
              setConfirmDelete(null)
              setCheckedLinks(current => ({ ...current, [skill.name]: undefined }))
              await refresh()
            })
          } }, confirmDelete === skill.name ? t('Click again to delete.') : t('Delete'))))
    })) : h('p', { className: 'bt-set-hint' }, t('No skills yet.')))
}
