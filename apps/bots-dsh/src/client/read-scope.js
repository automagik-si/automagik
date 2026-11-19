import { createElement as h, Fragment, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from './api.js'
import { t } from './i18n.js'
import { FolderIcon } from './icons.js'
import { useAnchoredMenu } from './model-menu.js'

const READ_FOLDER_LABEL = 'Folder for these four file tools'

export function ReadScopeControl({ sessionId }) {
  return typeof sessionId === 'string' ? h(SessionReadScope, { key: sessionId, sessionId }) : null
}

function SessionReadScope({ sessionId }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const [scope, setScope] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const load = async (signal) => {
    try {
      const value = await call('session-read-scope', { sessionId }, signal)
      setScope(value)
      setDraft(value.folder ?? '')
      setError('')
    } catch (failure) {
      if (!signal?.aborted) setError(failure.message)
    }
  }
  useEffect(() => {
    const lifetime = new AbortController()
    void load(lifetime.signal)
    return () => lifetime.abort()
  }, [sessionId])
  if (scope?.editable === false || (scope === null && error === '')) return null

  const save = async (folder) => {
    setSaving(true)
    setError('')
    try {
      const value = await call('set-session-read-scope', { sessionId, folder })
      setScope(value)
      setDraft(value.folder ?? '')
      close()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setSaving(false)
    }
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-expanded': isOpen,
      'aria-label': t('File-tool folder'), title: scope?.folder ?? t(READ_FOLDER_LABEL),
      onClick: () => {
        if (isOpen) close()
        else {
          setDraft(scope?.folder ?? '')
          if (scope === null) void load()
          open()
        }
      },
    }, h(FolderIcon)),
    shownPlace ? createPortal(h('form', {
      ref: menu, className: 'bt-menu bt-folder-menu', 'aria-label': t(READ_FOLDER_LABEL),
      style: shownPlace, 'data-leaving': leaving || undefined,
      onSubmit: (event) => { event.preventDefault(); if (scope?.editable && !saving && draft !== '') void save(draft) },
    },
    h('label', { className: 'bt-folder-view bt-folder-here' }, t(READ_FOLDER_LABEL),
      h('span', { className: 'bt-folder-path' }, 'read, read_image, glob, grep'),
      h('input', {
        className: 'bt-folder-input', value: draft, spellCheck: false, autoComplete: 'off',
        placeholder: t('Full path of a folder'), disabled: scope === null || saving,
        onChange: event => setDraft(event.target.value),
      })),
    h('button', { type: 'submit', className: 'bt-folder-use', disabled: scope === null || saving || draft === '' }, t('Use this folder')),
    h('button', { type: 'button', disabled: scope?.folder == null || saving, onClick: () => void save(null) }, t('Clear folder')),
    error ? h('div', { className: 'bt-folder-error', role: 'alert' }, error) : null), document.body) : null)
}
