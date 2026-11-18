import { createElement as h, Fragment } from 'react'
import { t } from './i18n.js'

export const HERDR_AGENTS = Object.freeze([
  { id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' },
  { id: 'hermes', name: 'Hermes' }, { id: 'antigravity', name: 'Antigravity' },
  { id: 'omp', name: 'omp' },
])

/** Empty type means the default native DSH Bot, including ACP models. */
export function BotTypeFields({ type, agent, onType, onAgent }) {
  return h(Fragment, null,
    h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Bot type')),
      h('select', { className: 'bt-input', 'aria-label': t('Bot type'), value: type ?? '', onChange: event => onType(event.target.value) },
        h('option', { value: '' }, t('Native DSH Bot')),
        h('option', { value: 'herdr' }, t('Herdr Bot')))),
    type === 'herdr' ? h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Terminal agent')),
      h('select', { className: 'bt-input', 'aria-label': t('Terminal agent'), value: agent ?? 'claude', onChange: event => onAgent(event.target.value) },
        ...HERDR_AGENTS.map(entry => h('option', { key: entry.id, value: entry.id }, entry.name))),
      h('span', { className: 'bt-note' }, t('This Bot uses only its terminal.'))) : null)
}
