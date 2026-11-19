import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const BOT_PACKAGE = '@automagik/bots-dsh'
const ADAPTERS = new Map([
  ['tool-fs', 'read-scope-files'],
  ['tool-fs-search', 'read-scope-search'],
])
const STOCK_IDS = new Map([...ADAPTERS].map(([id, name]) => [`automagik-${name}`, id]))
const PRESETS = new Map([
  ['standard', ['tool-fs', 'tool-fs-search']],
  ['ptc', ['tool-fs', 'tool-fs-search']],
  ['cordis', ['tool-fs', 'tool-fs-search']],
  ['minimal', ['tool-fs']],
])
const PRESET_IDS = new Set([...PRESETS.keys()].map(id => `preset-${id}`))
const PRESET_NAME = '@deepseek-ai/dsh-agent-preset'
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: text => text }
const PATCH_FILE = 'cordis.patch.yml'

function parsePatch(yaml, text, { allowOpaque = false } = {}) {
  const document = yaml.parseDocument(text, { customTags: [JS_TAG] })
  document.contents ??= document.createNode([])
  if (document.errors.length || !yaml.isSeq(document.contents)) {
    if (allowOpaque) return null
    throw new Error('Expected a profile patch sequence')
  }
  return document
}

function patchNodes(yaml, document) {
  const resolve = node => yaml.isAlias(node) ? node.resolve(document) : node
  const getNode = (node, key) => {
    const row = resolve(node)
    return yaml.isMap(row) ? resolve(row.get(key, true)) : undefined
  }
  const get = (node, key) => {
    const value = getNode(node, key)
    return yaml.isScalar(value) ? value.value : value
  }
  return { resolve, getNode, get }
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

function adaptPresetTools(yaml, nodes, config, available) {
  const { resolve, get } = nodes
  const replaced = new Set()
  const visited = new Set()
  function visit(list) {
    if (!yaml.isSeq(list) || visited.has(list)) return
    visited.add(list)
    for (const node of list.items) {
      const row = resolve(node)
      if (!yaml.isMap(row)) continue
      for (const [tool, adapter] of ADAPTERS) {
        const stockName = `@deepseek-ai/dsh-${tool}`
        const adapterName = `${BOT_PACKAGE}/${adapter}`
        if (get(row, 'name') !== (available ? stockName : adapterName)) continue
        row.set('name', available ? adapterName : stockName)
        replaced.add(tool)
      }
      if (get(row, 'group') === true) visit(get(row, 'config'))
    }
  }
  visit(get(config, 'plugins'))
  return replaced
}

function presetRegistrations(yaml, nodes, row) {
  const insert = nodes.get(row, 'insert')
  return yaml.isSeq(insert) ? insert.items.filter(plugin => nodes.get(plugin, 'name') === PRESET_NAME) : []
}

function adaptProfilePresets(yaml, patch, nodes, ids, available) {
  let changed = false
  for (const row of patch.contents.items) {
    const override = yaml.isMap(nodes.resolve(row)) && !nodes.resolve(row).has('insert')
    const name = nodes.get(row, 'name')
    const presets = override && (name === undefined || name === PRESET_NAME)
      ? [row] : presetRegistrations(yaml, nodes, row)
    for (const preset of presets) {
      if (!ids.has(nodes.get(preset, 'id'))) continue
      if (adaptPresetTools(yaml, nodes, nodes.get(preset, 'config'), available).size > 0) changed = true
    }
  }
  return changed
}

function removeUnavailableAdapters(yaml, patch) {
  const nodes = patchNodes(yaml, patch)
  const { get, resolve } = nodes
  const removed = new Set()
  const kept = new Set()
  const inserts = new Map()
  for (const row of patch.contents.items) {
    const insert = get(row, 'insert')
    if (!yaml.isSeq(insert) || inserts.has(insert)) continue
    const remaining = insert.items.filter(plugin => {
      const id = get(plugin, 'id')
      const stockId = STOCK_IDS.get(id)
      if (stockId !== undefined && get(plugin, 'name') === `${BOT_PACKAGE}/${ADAPTERS.get(stockId)}`) {
        removed.add(id)
        return false
      }
      kept.add(id)
      return true
    })
    if (remaining.length < insert.items.length) inserts.set(insert, remaining)
  }

  const items = patch.contents.items.filter(row => {
    if (inserts.get(get(row, 'insert'))?.length === 0) return false
    if (!yaml.isMap(resolve(row)) || resolve(row).has('insert')) return true
    const id = get(row, 'id')
    const stockId = STOCK_IDS.get(id)
    if (stockId === undefined) return true
    const name = get(row, 'name')
    if (name === undefined) return !removed.has(id) || kept.has(id)
    return name !== `${BOT_PACKAGE}/${ADAPTERS.get(stockId)}`
  })
  const removedRows = inserts.size > 0 || items.length !== patch.contents.items.length
  if (removedRows) {
    const aliases = new Map()
    yaml.visit(patch, { Alias: (_, node) => { aliases.set(node, resolve(node)) } })
    for (const [insert, remaining] of inserts) {
      if (remaining.length > 0) insert.items = remaining
    }
    patch.contents.items = items
    // Move an anchor from a retired row to the first setting that still uses it.
    yaml.visit(patch, { Alias: (_, node) => aliases.get(node) !== resolve(node) ? aliases.get(node) : undefined })
  }
  const changed = adaptProfilePresets(yaml, patch, nodes, PRESET_IDS, false)
  return removedRows || changed ? patch.toString() : null
}

function configureReadScopePatch(yaml, text, available, presetDirectory) {
  const patch = parsePatch(yaml, text)
  if (!available) {
    patch.contents.items = patch.contents.items.filter(row => !readScopeRow(yaml, row))
    return patch.toString()
  }
  // The preset list lives under config, which Cordis patches replace wholesale.
  // Derive that config from the installed preset and change only the tool module names.
  for (const [preset, tools] of PRESETS) {
    const id = `preset-${preset}`
    const source = parsePatch(yaml, readFileSync(join(presetDirectory, `${preset}.patch.yml`), 'utf8'))
    const config = source.getIn([0, 'insert', 0, 'config'], true)
    const replaced = adaptPresetTools(yaml, patchNodes(yaml, source), config, true)
    if (source.getIn([0, 'insert', 0, 'id']) !== id || replaced.size !== tools.length || !tools.every(tool => replaced.has(tool))) {
      throw new Error(`Unexpected DSH file tool registrations in the ${preset} preset`)
    }
    patch.add({ id, name: PRESET_NAME, config })
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

export function replaceProfilePatch(file, text, mode = 0o644) {
  const scratch = mkdtempSync(join(dirname(file), '.profile-patch-'))
  try {
    const replacement = join(scratch, PATCH_FILE)
    writeFileSync(replacement, text, { mode })
    renameSync(replacement, file)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Merge registrations by insert target and plugin id, and settings by override operation. */
export function mergePatch(yaml, user, shipped, { readScopeOnly = false, readScopeAvailable = true } = {}) {
  if (!readScopeAvailable) {
    // Adapter-free upgrades have always carried opaque patches through unchanged.
    const patch = parsePatch(yaml, user, { allowOpaque: true })
    return patch === null ? null : removeUnavailableAdapters(yaml, patch)
  }
  const source = parsePatch(yaml, shipped)
  const rows = source.contents.items.filter(row => !readScopeOnly || readScopeRow(yaml, row))
  if (rows.length === 0) return null
  const patch = parsePatch(yaml, user)
  if (!readScopeOnly && user.trim() === '[]') return shipped

  const items = patch.contents.items
  const nodes = patchNodes(yaml, patch)
  const { resolve: rowOf, get, getNode } = nodes
  const isOverride = node => yaml.isMap(rowOf(node)) && !rowOf(node).has('insert')
  const overridesOf = (id, name) => items.filter(node => isOverride(node) && get(node, 'id') === id
    && (get(node, 'name') === undefined || get(node, 'name') === name))
  const presetIds = new Set(rows.map(row => row.get('id')).filter(id => PRESET_IDS.has(id)))
  let changed = false

  function retainStockSettings(plugin, defaults, added) {
    const id = get(plugin, 'id')
    const stockId = STOCK_IDS.get(id)
    if (stockId === undefined || get(plugin, 'name') !== `${BOT_PACKAGE}/${ADAPTERS.get(stockId)}`) return
    const stock = overridesOf(stockId, `@deepseek-ai/dsh-${stockId}`)
    const adapter = overridesOf(id, get(plugin, 'name'))
    if (added || !plugin.has('disabled')) {
      const disabled = getNode(stock.findLast(node => rowOf(node).has('disabled')), 'disabled') ?? defaults.get('disabled', true)
      if (yaml.isScalar(disabled)) {
        // Keep the !!js tag without evaluating it or introducing a forward alias.
        const value = disabled.clone()
        delete value.anchor
        plugin.set('disabled', value)
        changed = true
      }
    }
    if (!added) return
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
      const registered = new Map(items.flatMap(node => {
        const plugins = get(node, 'insert')
        return yaml.isSeq(plugins) && get(node, 'id') === id ? plugins.items.map(plugin => [get(plugin, 'id'), rowOf(plugin)]) : []
      }))
      const missing = insert.items.filter(plugin => !registered.has(plugin.get('id')))
      for (const defaults of insert.items) {
        const plugin = registered.get(defaults.get('id'))
        retainStockSettings(plugin ?? defaults, defaults, plugin === undefined)
      }
      if (missing.length === 0) continue
      const ids = new Set(missing.map(plugin => plugin.get('id')))
      const firstOverride = items.findIndex(node => isOverride(node) && ids.has(get(node, 'id')))
      insert.items = missing
      items.splice(firstOverride === -1 ? items.length : firstOverride, 0, row)
    } else {
      const preset = presetIds.has(id)
      const stockSwitch = ADAPTERS.has(id) && row.get('disabled') === true
      const targetName = preset ? PRESET_NAME : stockSwitch ? `@deepseek-ai/dsh-${id}` : row.get('name')
      const overrides = overridesOf(id, targetName)
      if (stockSwitch) {
        const lastSwitch = overrides.findLast(node => rowOf(node).has('disabled'))
        if (get(lastSwitch, 'disabled') === true) continue
        // The stock and adapter registrations cannot both mount in the global tool layer.
        items.push(row)
      } else {
        if (overrides.some(node => !preset || rowOf(node).has('config'))) continue
        if (preset && items.some(node => presetRegistrations(yaml, nodes, node).some(plugin => get(plugin, 'id') === id))) continue
        const firstOverride = items.indexOf(overrides[0])
        items.splice(firstOverride === -1 ? items.length : firstOverride, 0, row)
      }
    }
    changed = true
  }

  if (adaptProfilePresets(yaml, patch, nodes, presetIds, true)) changed = true
  return changed ? patch.toString() : null
}
