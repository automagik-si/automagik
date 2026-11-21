import { compareVersions } from '../lane-verify.js'

export const PLUGINS = ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh'].map(name => `@automagik/${name}`)
export const isLaneVersion = value => typeof value === 'string' && value.trim() === value && compareVersions(value, value) === 0

// The saved check proves exact equality. Only the signed release identity crosses to the supervisor.
export function reinstallIntent(value, { saved = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (saved ? value.version !== 2 || value.state !== 'available' || value.reinstall !== true
    : Object.keys(value).length !== 3) return null
  const version = saved ? value.laneVersion : value.version
  const { sequence, plugins } = value
  if (!isLaneVersion(version) || !Number.isSafeInteger(sequence) || sequence < 0
    || !Array.isArray(plugins) || plugins.length === 0 || plugins.length > PLUGINS.length) return null

  let previous = ''
  const selected = []
  for (const plugin of plugins) {
    if (!plugin || !PLUGINS.includes(plugin.name) || plugin.name <= previous
      || typeof plugin.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(plugin.sha256)
      || (saved ? plugin.from !== version || plugin.to !== version : Object.keys(plugin).length !== 2)) return null
    previous = plugin.name
    selected.push({ name: plugin.name, sha256: plugin.sha256.toLowerCase() })
  }
  return { version, sequence, plugins: selected }
}
