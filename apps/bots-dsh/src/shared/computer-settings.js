import { createHash } from 'node:crypto'

// DSH 0.2.2-rc.2 and rc.3 register these filesystem, editor and Office tools.
export const FILE_TOOLS = Object.freeze([
  'apply_patch', 'edit', 'glob', 'grep', 'office_convert', 'office_recalculate',
  'office_render', 'read', 'read_image', 'str_replace_editor', 'write',
])

const LEVELS = ['off', 'view', 'background', 'foreground']
const owns = (object, key) => Object.hasOwn(object, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim() !== ''
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function switchesOf(bot) {
  return {
    terminal: bot?.shell !== false,
    files: filesMirrorState(bot) === 'on',
    computerUse: LEVELS.includes(bot?.computer?.level) ? bot.computer.level : 'off',
  }
}

export function switchPatch(input) {
  if (!record(input)) throw invalid('Invalid Bot switch update.')
  const switches = owns(input, 'switches') ? input.switches : {}
  if (!record(switches) || Object.keys(switches).some(key => !['terminal', 'files', 'computerUse'].includes(key))) {
    throw invalid('Invalid Bot switches.')
  }
  const computer = owns(input, 'computer') ? input.computer : {}
  if (!record(computer) || Object.keys(computer).some(key => !['level', 'apps'].includes(key))) {
    throw invalid('Invalid Bot computer settings.')
  }
  for (const [modern, legacy, key] of [
    [switches, input, ['terminal', 'shell']],
    [switches, computer, ['computerUse', 'level']],
    [input, computer, ['apps', 'apps']],
  ]) {
    if (owns(modern, key[0]) && owns(legacy, key[1])) {
      throw invalid('Specify each Bot switch or app setting once.')
    }
  }
  const patch = {}
  const terminal = owns(switches, 'terminal') ? switches.terminal : input.shell
  if (terminal !== undefined) {
    if (typeof terminal !== 'boolean') throw invalid('Terminal must be true or false.')
    patch.shell = terminal
  }
  if (owns(switches, 'files')) {
    if (typeof switches.files !== 'boolean') throw invalid('Files must be true or false.')
    patch.files = switches.files
  }
  const level = owns(switches, 'computerUse') ? switches.computerUse : computer.level
  if (level !== undefined) {
    if (!LEVELS.includes(level)) throw invalid('Invalid Computer use level.')
    patch.level = level
  }
  const apps = owns(input, 'apps') ? input.apps : computer.apps
  if (apps !== undefined) {
    if (!record(apps) || Object.entries(apps).some(([key, grant]) =>
      !text(key) || !record(grant) || !text(grant.name) || !Number.isFinite(grant.grantedAt)
      || (owns(grant, 'id') && !text(grant.id)) || (owns(grant, 'path') && !text(grant.path))
      || Object.keys(grant).some(field => !['name', 'grantedAt', 'id', 'path'].includes(field)))) {
      throw invalid('Computer apps must be valid app grants.')
    }
    patch.apps = structuredClone(apps)
  }
  return patch
}

const denyList = bot => Array.isArray(bot?.denyTools) ? bot.denyTools : []
const digestOf = names => createHash('sha256').update(JSON.stringify(names)).digest('hex')

export function filesMirrorState(bot) {
  const denied = denyList(bot)
  const mirror = bot?.filesMirror
  const complete = FILE_TOOLS.every(name => denied.includes(name))
  if (mirror === undefined) return complete ? 'stale' : 'on'
  return complete && record(mirror) && mirror.digest === digestOf(denied)
    && Array.isArray(mirror.added) && new Set(mirror.added).size === mirror.added.length
    && mirror.added.every(name => FILE_TOOLS.includes(name) && denied.includes(name)) ? 'off' : 'stale'
}

export function carryFilesMirror(bot, denied, addedExplicit = []) {
  const state = filesMirrorState(bot)
  if (state === 'on') return undefined
  if (state === 'stale') return structuredClone(bot.filesMirror)
  return { added: bot.filesMirror.added.filter(name => !addedExplicit?.includes(name)), digest: digestOf(denied) }
}

export function filesDenyMirror(bot, files, replacement, limit) {
  const state = filesMirrorState(bot)
  if (files && state === 'stale' && replacement === undefined) {
    throw invalid('Files denial provenance is stale. Review the Advanced denied tools list to restore access.')
  }
  const previousMirror = new Set(state === 'off' ? bot.filesMirror.added : [])
  const explicit = replacement === undefined
    ? denyList(bot).filter(name => !previousMirror.has(name)) : replacement ?? []
  const names = new Set(explicit)
  const added = files ? [] : FILE_TOOLS.filter(name => !names.has(name))
  const denyTools = [...names, ...added]
  if (denyTools.length > limit) {
    throw invalid(`Files off needs ${denyTools.length - limit} more denied-tool slots; this Bot uses ${names.size} of ${limit}.`)
  }
  return { denyTools, filesMirror: files ? undefined : { added, digest: digestOf(denyTools) } }
}
