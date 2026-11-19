import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const BOT_PACKAGE = '@automagik/bots-dsh'
const ADAPTERS = new Map([
  ['tool-fs', 'read-scope-files'],
  ['tool-fs-search', 'read-scope-search'],
])
const STOCK_IDS = new Map([...ADAPTERS].map(([id, name]) => [`automagik-${name}`, id]))
const PRESETS = ['standard', 'ptc']
const PRESET_IDS = new Set(PRESETS.map(id => `preset-${id}`))
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: text => text }
const PATCH_FILE = 'cordis.patch.yml'

function parsePatch(yaml, text) {
  const document = yaml.parseDocument(text, { customTags: [JS_TAG] })
  document.contents ??= document.createNode([])
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new Error('Expected a profile patch sequence')
  return document
}

function readScopeRow(yaml, row) {
  if (!yaml.isMap(row)) return false
  const insert = row.get('insert')
  if (yaml.isSeq(insert)) {
    return insert.items.some(plugin => yaml.isMap(plugin) && STOCK_IDS.has(plugin.get('id')))
  }
  const id = row.get('id')
  return PRESET_IDS.has(id) || (ADAPTERS.has(id) && row.get('disabled') === true)
}

// Keep the adapters a pair. Resolve their exports in the installed Bot release without loading it.
export function hasReadScopeAdapters(profile) {
  const manifest = JSON.parse(readFileSync(join(profile, 'node_modules', BOT_PACKAGE, 'package.json'), 'utf8'))
  if (manifest.exports == null) return false
  const require = createRequire(join(profile, 'package.json'))
  const available = [...ADAPTERS.values()].map(name => {
    try {
      require.resolve(`${BOT_PACKAGE}/${name}`)
      return true
    } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
      return false
    }
  })
  if (available.some(Boolean) && !available.every(Boolean)) throw new Error('The Bot release exports only one file-scope adapter')
  return available.every(Boolean)
}

function adaptPresetTools(yaml, config) {
  const replaced = new Set()
  function visit(list) {
    if (!yaml.isSeq(list)) return
    for (const row of list.items) {
      if (!yaml.isMap(row)) continue
      for (const [tool, adapter] of ADAPTERS) {
        if (row.get('name') !== `@deepseek-ai/dsh-${tool}`) continue
        row.set('name', `${BOT_PACKAGE}/${adapter}`)
        replaced.add(tool)
      }
      if (row.get('group') === true) visit(row.get('config'))
    }
  }
  if (yaml.isMap(config)) visit(config.get('plugins'))
  return replaced.size
}

function configureReadScopePatch(yaml, text, available, presetDirectory) {
  const patch = parsePatch(yaml, text)
  if (!available) {
    patch.contents.items = patch.contents.items.filter(row => !readScopeRow(yaml, row))
    return patch.toString()
  }
  // The preset list lives under config, which Cordis patches replace wholesale.
  // Derive that config from the installed preset and change only the two module names.
  for (const preset of PRESETS) {
    const id = `preset-${preset}`
    const source = parsePatch(yaml, readFileSync(join(presetDirectory, `${preset}.patch.yml`), 'utf8'))
    const config = source.getIn([0, 'insert', 0, 'config'], true)
    if (source.getIn([0, 'insert', 0, 'id']) !== id || adaptPresetTools(yaml, config) !== ADAPTERS.size) {
      throw new Error(`Unexpected DSH file tool registrations in the ${preset} preset`)
    }
    patch.add({ id, config })
  }
  return patch.toString()
}

export function writeShippedProfilePatch(source, profile, runtime, { requireAdapters = false } = {}) {
  const available = hasReadScopeAdapters(profile)
  if (requireAdapters && !available) throw new Error('The desktop Bot release is missing the file-scope adapters')
  const yaml = createRequire(join(runtime, 'package.json'))('yaml')
  const text = readFileSync(join(source, PATCH_FILE), 'utf8')
  const presets = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
  writeFileSync(join(profile, PATCH_FILE), configureReadScopePatch(yaml, text, available, presets))
}

/** Merge registrations by insert target and plugin id, and settings by override operation. */
export function mergePatch(yaml, user, shipped, { readScopeOnly = false } = {}) {
  const source = parsePatch(yaml, shipped)
  const rows = source.contents.items.filter(row => !readScopeOnly || readScopeRow(yaml, row))
  if (rows.length === 0) return null
  const patch = parsePatch(yaml, user)
  if (!readScopeOnly && user.trim() === '[]') return shipped

  const items = patch.contents.items
  const rowOf = node => yaml.isAlias(node) ? node.resolve(patch) : node
  const get = (node, key) => {
    const row = rowOf(node)
    return yaml.isMap(row) ? rowOf(row.get(key)) : undefined
  }
  const isOverride = node => yaml.isMap(rowOf(node)) && !rowOf(node).has('insert')
  const overridesOf = (id, name) => items.filter(node => isOverride(node) && get(node, 'id') === id
    && (get(node, 'name') === undefined || get(node, 'name') === name))
  const presetIds = new Set(rows.map(row => row.get('id')).filter(id => PRESET_IDS.has(id)))
  let changed = false

  function retainStockSettings(plugin) {
    const id = plugin.get('id')
    const stockId = STOCK_IDS.get(id)
    if (stockId === undefined) return
    const stock = overridesOf(stockId, `@deepseek-ai/dsh-${stockId}`)
    const adapter = overridesOf(id, plugin.get('name'))
    const disabled = stock.findLast(node => rowOf(node).has('disabled'))
    if (adapter.length === 0 && get(disabled, 'disabled') === true) plugin.set('disabled', true)
    if (adapter.some(node => rowOf(node).has('config'))) return
    const settings = stock.findLast(node => rowOf(node).has('config'))
    const config = rowOf(settings)?.get('config', true)
    if (!yaml.isNode(config)) return
    // Reuse the existing config node, including flags that disable native write tools.
    const reference = yaml.isAlias(config) ? config.clone() : patch.createAlias(config)
    items.push(patch.createNode({ id, config: reference }))
  }

  for (const row of rows) {
    const id = row.get('id')
    const insert = row.get('insert')
    if (yaml.isSeq(insert)) {
      const registered = new Set(items.flatMap(node => {
        const plugins = get(node, 'insert')
        return yaml.isSeq(plugins) && get(node, 'id') === id ? plugins.items.map(plugin => get(plugin, 'id')) : []
      }))
      const missing = insert.items.filter(plugin => !registered.has(plugin.get('id')))
      if (missing.length === 0) continue
      for (const plugin of missing) retainStockSettings(plugin)
      const ids = new Set(missing.map(plugin => plugin.get('id')))
      const firstOverride = items.findIndex(node => isOverride(node) && ids.has(get(node, 'id')))
      insert.items = missing
      items.splice(firstOverride === -1 ? items.length : firstOverride, 0, row)
    } else {
      const preset = presetIds.has(id)
      const stockSwitch = ADAPTERS.has(id) && row.get('disabled') === true
      const targetName = preset ? '@deepseek-ai/dsh-agent-preset' : stockSwitch ? `@deepseek-ai/dsh-${id}` : row.get('name')
      const overrides = overridesOf(id, targetName)
      if (stockSwitch) {
        const lastSwitch = overrides.findLast(node => rowOf(node).has('disabled'))
        if (get(lastSwitch, 'disabled') === true) continue
        // The stock and adapter registrations cannot both mount in the global tool layer.
        items.push(row)
      } else {
        if (overrides.some(node => !preset || rowOf(node).has('config'))) continue
        const firstOverride = items.indexOf(overrides[0])
        items.splice(firstOverride === -1 ? items.length : firstOverride, 0, row)
      }
    }
    changed = true
  }

  for (const row of items) {
    if (isOverride(row) && presetIds.has(get(row, 'id')) && adaptPresetTools(yaml, get(row, 'config')) > 0) changed = true
  }
  return changed ? patch.toString() : null
}
