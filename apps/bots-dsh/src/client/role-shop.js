import { createElement as h } from 'react'
import { attachedRoleIds, BUILTIN_ROLES, packageDeclarations, rolesOn } from '../shared/roles.js'
import { Card, Row, roleHealth, roleReadOnly } from './bot-settings.js'
import { t } from './i18n.js'
import { roleName, roleProvider } from './team-actions.js'

const BUILTIN_KEY = 'role:builtin:genie'
const COMMUNITY_REASON = 'Community roles can be installed once their isolated runtime ships.'
const UNINSTALL_REASON = 'Detach this role from every Bot before uninstalling it.'
const own = (map, id) => Object.hasOwn(map ?? {}, id) ? map[id] : undefined
const actionReason = row => row.record ? row.inUse && t(UNINSTALL_REASON)
  : row.listed?.installable === false && t(COMMUNITY_REASON)
const checksum = sha256 => h('code', null, sha256.match(/.{1,16}/g).map((part, index) =>
  h('span', { key: index }, index ? h('wbr') : null, part)))

export function shopRoles(roster) {
  const bots = roster?.bots ?? Object.values(roster?.byId ?? {})
  const attached = new Set(bots.flatMap(attachedRoleIds))
  const catalog = new Map((roster?.roleCatalog?.roles ?? []).map(role => [role.id, role]))
  const rows = (roster?.roleProviders ?? []).map(provider => ({
    key: `role:registry:${provider.id}`, id: provider.id, name: roleName(roster, provider.id), provider,
  }))
  if (!rolesOn(roster?.prefs)) return rows
  if (!roleProvider(roster, 'genie') && bots.some(bot => bot.kind === BUILTIN_ROLES.genie.kind)) {
    rows.push({ key: BUILTIN_KEY, id: 'genie', name: t('Genie'), builtIn: true })
  }
  for (const id of new Set([...catalog.keys(), ...Object.keys(roster?.roles ?? {})])) {
    const listed = catalog.get(id)
    const record = own(roster?.roles, id)
    const details = own(roster?.roleDetails, id)
    const declarations = record ? packageDeclarations({ id, version: record.version }, roster) : details?.catalog
    rows.push({
      key: `role:${id}`, id, name: declarations?.name ?? listed?.name ?? id,
      listed, record, details, declarations, inUse: attached.has(id),
    })
  }
  // Keep catalog order within each group, followed by records absent from the catalog.
  const rank = row => row.builtIn || row.provider ? 0 : row.listed?.installable ? 1 : row.listed ? 2 : 3
  return rows.sort((a, b) => rank(a) - rank(b))
}

function roleAction(row, roster, actions, operation, className) {
  if (row.builtIn || row.provider) return null
  const { id, record } = row
  const action = record ? actions.uninstallRole : actions.installRole
  const reason = actionReason(row)
  const disabled = operation.pending || roleReadOnly(roster) || Boolean(reason) || !action
  return h('button', {
    type: 'button', className, disabled, title: reason || undefined,
    onClick: () => { if (!disabled) return operation.change(action, id) },
  }, record ? t('Uninstall') : t('Install'))
}

function RoleTile({ row, roster, actions, operation, open }) {
  const { name, builtIn, provider, record, listed, declarations } = row
  const tag = builtIn ? t('Built in') : listed ? t(listed.installable ? 'Official' : 'Community') : t('Installed')
  const reason = actionReason(row)
  const status = [record && (record.status === 'ok' ? t('Installed') : roleHealth(record.status)),
    record ? record.version : listed?.version ?? provider?.version, declarations?.description].filter(Boolean).join(' · ')
  return h('div', null,
    h('div', { className: 'bt-app', 'data-state': record || builtIn || provider ? 'ready' : 'off' },
      h('button', { type: 'button', className: 'bt-app-main', onClick: () => open(row.key) },
        h('span', { className: 'bt-app-text' },
          h('span', { className: 'bt-app-name' }, name, h('span', { className: 'bt-tag' }, tag)),
          status ? h('span', { className: 'bt-app-status' }, status) : null)),
      roleAction(row, roster, actions, operation, 'bt-app-btn')),
    reason ? h('div', { className: 'bt-set-hint' }, reason) : null)
}

export function RoleShopSection({ rows, roster, actions, operation, open }) {
  if (!rows.length) return null
  return h('section', { className: 'bt-app-section' },
    h('div', { className: 'bt-app-section-head' }, h('h3', null, t('Roles'))),
    h('div', { className: 'bt-app-grid' },
      rows.map(row => h(RoleTile, { key: row.key, row, roster, actions, operation, open }))))
}

function newerVersion(candidate, installed) {
  if (!candidate || !installed) return false
  const pinned = installed.split('.').map(Number)
  for (const [index, part] of candidate.split('.').map(Number).entries()) {
    if (part !== pinned[index]) return part > pinned[index]
  }
  return false
}

export function RoleShopCard({ row, roster, actions, operation }) {
  if (row.provider) return h(Card, null,
    h(Row, { label: t('Installed'), hint: t('Attach it from the Bot’s settings.') }),
    h(Row, { label: t('Declared tools'), hint: row.provider.tools.join(', ') || t('None') }),
    h(Row, { label: t('Grants requested'), hint: row.provider.capabilities.join(', ') || t('None') }))
  if (row.builtIn) return h(Card, null,
    h(Row, { label: t('Built in'), hint: t("Attach it from a Genie Bot's settings") }))
  const { record, listed, details, declarations } = row
  const catalog = details?.catalog
  const installed = details?.installed
  const grants = record ? declarations?.capabilities : listed?.capabilities
  const reason = actionReason(row)
  const runtime = listed?.installable || installed?.attachable ? t('Runs in the Bot team')
    : listed ? t('Waits for the isolated runtime') : undefined
  return h(Card, null,
    h(Row, { label: t('Publisher'), hint: (record ? record.publisher : listed?.publisher) ?? t('Details unavailable') },
      roleAction(row, roster, actions, operation, 'bt-soft bt-soft-sm')),
    reason ? h(Row, { label: reason }) : null,
    record ? h(Row, { label: t('Installed version'), hint: [record.version, record.status !== 'ok' && roleHealth(record.status)].filter(Boolean).join(' · ') }) : null,
    installed ? h(Row, { label: t('Installed SHA-256'), hint: installed.sha256 ? checksum(installed.sha256) : t('Details unavailable'), stack: true }) : null,
    listed ? h(Row, { label: t('Catalog version'), hint: listed.version }) : null,
    catalog ? h(Row, { label: t('Catalog SHA-256'), hint: checksum(catalog.sha256), stack: true }) : null,
    newerVersion(listed?.version, record?.version) ? h(Row, { label: t('Update available') }) : null,
    h(Row, { label: t('Description'), hint: declarations?.description || t('Details unavailable') }),
    h(Row, { label: t('Declared tools'), hint: declarations?.tools ? declarations.tools.join(', ') || t('None') : t('Details unavailable') }),
    h(Row, { label: t('Grants requested'), hint: grants ? grants.join(', ') || t('None') : t('Details unavailable') }),
    (declarations?.fromCatalog || (!record && catalog)) ? h(Row, { label: t('From the catalog') }) : null,
    h(Row, { label: t('What it may not change'),
      hint: t('Model, permissions, shell, folder, channels, memory, Sessions, Main Bot powers, name or look') }),
    runtime ? h(Row, { label: runtime }) : null)
}
