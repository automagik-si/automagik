import { createElement as h, Fragment } from 'react'
import { SEAT_AGENTS } from '../shared/bot-types.js'
import { t } from './i18n.js'

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', antigravity: 'Antigravity', omp: 'Oh My Pi', pi: 'Pi', opencode: 'OpenCode', cursor: 'Cursor', copilot: 'Copilot', amp: 'Amp', grok: 'Grok', kimi: 'Kimi', kiro: 'Kiro', qoder: 'Qoder', crush: 'Crush', 'dsh-tui': 'dsh-TUI' }
export const HERDR_AGENTS = Object.freeze(SEAT_AGENTS.map(id => ({ id, name: AGENT_NAMES[id] })))

/** Empty type means the default native DSH Bot, including ACP models. */
export function BotTypeFields({ type, agent, onType, onAgent, main = false }) {
  return h(Fragment, null,
    h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Bot type')),
      h('select', { className: 'bt-input', 'aria-label': t('Bot type'), value: type ?? '', onChange: event => onType(event.target.value) },
        h('option', { value: '' }, t('Native DSH Bot')),
        main ? null : h('option', { value: 'herdr' }, t('Herdr Bot'))),
      main ? h('span', { className: 'bt-note' }, t('A Main Bot cannot be a Herdr Bot.')) : null),
    type === 'herdr' ? h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Terminal agent')),
      h('select', { className: 'bt-input', 'aria-label': t('Terminal agent'), value: agent ?? 'claude', onChange: event => onAgent(event.target.value) },
        ...HERDR_AGENTS.map(entry => h('option', { key: entry.id, value: entry.id }, entry.name))),
      h('span', { className: 'bt-note' }, t('This Bot uses only its terminal.'))) : null)
}
