import { createElement as h, useState } from 'react'
import { canManageSkills, useSkillLibrary } from './skills-screen.js'
import { AUTOMATIC_SKILL_MODE, DEFAULT_SKILL_MODE } from '../shared/skill-mode.js'
import { hostText, t } from './i18n.js'

export function BotSkills({ bot, roster, actions }) {
  return canManageSkills() && typeof actions?.skillLibrary === 'function'
    ? h(OwnerBotSkills, { key: bot.id, bot, roster, actions }) : null
}

function SkillMode({ label, mode, onChange, disabled }) {
  return h('select', { className: 'bt-select', 'aria-label': label, value: mode, disabled,
    onChange: event => onChange(event.target.value) },
  h('option', { value: DEFAULT_SKILL_MODE }, t('Only when I call')),
  h('option', { value: AUTOMATIC_SKILL_MODE }, t('Automatic')))
}

function OwnerBotSkills({ bot, roster, actions }) {
  const { library, error, setError, refresh } = useSkillLibrary(actions)
  const [mode, setMode] = useState(DEFAULT_SKILL_MODE)
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState(false)
  const active = Object.hasOwn(library.active, bot.id) ? library.active[bot.id] : []
  const attached = new Set(active.map(item => item.name))
  const choices = library.skills.filter(skill => !skill.held && !attached.has(skill.name))
  const disabled = busy || !!roster.readOnly
  const save = async action => {
    if (disabled) return
    setBusy(true)
    setError('')
    setWarning('')
    try {
      const result = await action()
      if (result.warning) setWarning(hostText(result.warning))
      await refresh()
    } catch (failure) {
      setError(hostText(failure.message))
    } finally { setBusy(false) }
  }
  return h('section', { className: 'bt-drawer-model' },
    h('div', { className: 'bt-section-title' }, t('Skills')),
    h('div', { className: 'bt-set-row bt-bs-row' },
      h(SkillMode, { label: t('New skill mode'), mode, disabled: disabled || choices.length === 0, onChange: setMode }),
      h('select', { className: 'bt-select', 'aria-label': t('Add skill'), disabled: disabled || choices.length === 0,
        value: '', onChange: event => {
          const name = event.target.value
          if (name) void save(async () => {
            const added = await actions.setBotSkill(bot.id, name, true, mode)
            setMode(DEFAULT_SKILL_MODE)
            return added
          })
        } },
      h('option', { value: '' }, t('Add skill')),
      choices.map(({ name }) => h('option', { key: name, value: name }, name)))),
    active.length ? active.map(({ name, mode }) => {
      const item = library.skills.find(skill => skill.name === name)
      return h('div', { key: name, className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, name,
          item?.held ? h('span', { className: 'bt-set-hint' }, hostText(item.held)) : null),
        h(SkillMode, { label: t('Mode for {name}', { name }), mode, disabled: disabled || !!item?.held,
          onChange: next => void save(() => actions.setBotSkillMode(bot.id, name, next)) }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled,
          onClick: () => void save(() => actions.setBotSkill(bot.id, name, false)) }, t('Remove')))
    }) : h('p', { className: 'bt-set-hint' }, t('No skills are active on this Bot.')),
    warning ? h('p', { className: 'bt-set-hint', role: 'status' }, warning) : null,
    error ? h('p', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null)
}
