import { createHash } from 'node:crypto'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { noBotRunner } from './bot-runner.js'
import { refusal } from './refusal.js'
import { encodeUrlComponent } from './secrets.js'
import { own } from './store.js'
import { skillRefusal } from './skill-keys.js'
import { installSkillRecords, skillDeleteBinding, skillRecordId } from './skill-records.js'
import { isPortableDeviceName, skillName } from './skill-store.js'

export { RESERVED_COMMAND_NAMES, RESERVED_COMMANDS_VERSION, reservedCommandOf } from '../shared/reserved-commands.js'
export { skillRecordId, validSkillRecord } from './skill-records.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000
// One initialize request, as the mount sends it. The SDK's reconnect budget is not a probe:
// a save that retried would leave the user waiting on a server that already refused.
const PROBE_TIMEOUT_MS = 10_000
const SAVED_BY_BOT = name => `${name} was last saved by a Bot, not in Settings → Capabilities. A Session mount takes only a capability the person saved there; save it there to use it.`
const PROBE_EXCERPT_CHARS = 200
const PROBE_REASON_CHARS = 300
const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'automagik-bots-dsh', version: '1' } },
})

// Connector ids are reserved: a capability named like one would collide with
// its mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(['github', 'mail'])
export function validateCapabilityName(value, reserved = CONNECTOR_IDS, { kind, creating = true } = {}) {
  const name = String(value ?? '').trim()
  const command = creating && reservedCommandOf(value)
  if (command) throw skillRefusal('name-reserved', { name: command })
  if (!skillName(name) || name === 'github' || reserved.has(name)) throw skillRefusal('name-format')
  if (creating && kind === 'skill' && isPortableDeviceName(name)) throw skillRefusal('name-device', { name })
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = own(library, name)
    if (!item) throw refusal(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = own(library, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw refusal(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw refusal(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw refusal('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw refusal(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

export function install(rt) {
  const { ctx, state } = rt
  const agents = new Map()
  // Mounted fibers live in each Agent's own context, so they outlive this plugin unless
  // its cleanup disposes them; a strong map keeps them reachable for that.
  const mounts = new Map()
  const admittedTurns = new WeakMap()
  const waitingForIdle = new WeakSet()
  const capturesSkills = agent => agent.status === 'running' && admittedTurns.has(agent)

  function reconcileAfterTurn(agent) {
    if (waitingForIdle.has(agent) || typeof agent.whenIdle !== 'function') return
    waitingForIdle.add(agent)
    const reconcile = () => {
      waitingForIdle.delete(agent)
      admittedTurns.delete(agent)
      if (!stopped) void scheduleReconcile()
    }
    void agent.whenIdle().then(reconcile, reconcile)
  }
  // One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
  const chains = new WeakMap()
  const queued = new WeakSet()
  const sessionStatuses = new Map()
  let pluginPromise
  let scheduled = null
  let loadingSecrets = 0
  let stopped = false

  // What another plugin mounted into one plain Session (mountCapability), by Session id:
  // name -> { secrets }, the secrets that mount may resolve. In memory only: a restart
  // restores none, and the plugin that owns the Session mounts again. Each status of such a
  // mount is kept by Session id and capability name.
  const grants = new Map()
  const grantStatuses = new Map()
  const runnerWarnings = new Set()
  const needsRunner = (item, sessionId, agent) => item.kind === 'mcp' && rt.botRunnerRequired?.(sessionId, agent)
  const runnerWarning = (name) => {
    const error = noBotRunner()
    if (!runnerWarnings.has(name)) {
      runnerWarnings.add(name)
      rt.warn('ds-bot: capability %s skipped: %s', name, error.message)
    }
    return error
  }

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && (bot.capabilities ?? []).some((attached) => {
      const item = own(library(), attached)
      return attached === name || (item?.kind === 'pack' && (item.items ?? []).includes(name))
    }))
  // A creator that is not a Main Bot could otherwise rewrite what a Main Bot runs.
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw refusal(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) throw refusal(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
  }
  function checkPackItems(names, items) {
    for (const name of names) {
      const child = own(items, name)
      if (!child || !['mcp', 'skill'].includes(child.kind)) throw refusal(`Packs can include only saved MCP servers and skills. ${name} is not one.`)
    }
  }
  const itemInput = (body, { botId, ui }) => {
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw refusal('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = own(items, String(body.name ?? '').trim())
    const name = validateCapabilityName(body.name, CONNECTOR_IDS, { kind, creating: !previous })
    if (previous && !ui) editCheck(previous, botId, 'change')
    if (previous && previous.kind !== kind) throw refusal('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      // An edit never claims creation: null is the user's entry, and missing
      // provenance is unknown. Neither may become the editing Bot's orphan.
      createdBy: previous ? previous.createdBy ?? null : ui ? null : botId ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      // Older saves could misattribute a user entry to its Bot editor. Only a new
      // Bot request establishes provenance; edits never upgrade an unmarked entry.
      if (previous?.botRequested === true || (!previous && !ui && rt.botOf(botId))) item.botRequested = true
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw refusal('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw refusal()
        } catch { throw refusal('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
      // A Bot may name only keys saved for it: a key it may not use never goes where it says.
      if (!ui) {
        const others = [...referencedSecrets(item)].filter(secret => !rt.canUseSecret(secret, botId))
        if (others.length > 0) throw refusal(`Not saved: ${item.name} uses ${others.join(', ')}, which ${others.length === 1 ? 'is' : 'are'} not saved for you. A capability you save may use only keys saved for you; ask for one with request_secret.`)
      }
      // Only the person's own save in Settings marks it as theirs; a Session mount takes no other.
      if (ui) item.fromSettings = true
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      checkPackItems(names, items)
      item.items = names
    }
    return item
  }
  function deleteFrom(team, name) {
    const items = team.capabilities.items
    delete items[name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== name)
    for (const bot of Object.values(team.bots)) bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== name)
  }
  const skills = installSkillRecords(rt, {
    library, deleteFrom, input: itemInput, authorizeEdit: editCheck,
    validateName: (name, options) => validateCapabilityName(name, CONNECTOR_IDS, options),
  })
  function checkLibraryTarget(name, previous, team) {
    const { epoch, term } = rt.teamGeneration()
    if (epoch !== team.epoch || term !== team.term || own(library(), name) !== previous) throw skillRefusal('changed-elsewhere')
    writeCheck()
  }
  const capabilitySave = async (body, options = {}) => {
    const text = body?.kind === 'skill' ? {
      kind: 'skill', name: String(body.name ?? ''), description: String(body.description ?? ''), content: String(body.content ?? ''),
    } : undefined
    if (text) options = { ...options }
    const loaded = rt.load()
    const team = { ...(options.team ?? rt.teamGeneration()) }
    if (text) {
      writeCheck()
      const request = skills.textRequest(text, options, team)
      await loaded
      await loadInputs()
      writeCheck()
      await rt.skillsReady()
      const { item } = await rt.skillCommit(request)
      return item
    }
    await loaded
    await loadInputs()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    const previous = own(library(), item.name)
    if (item.kind === 'mcp' && item.transport === 'streamable-http') {
      item.verification = options.ui && body?.unverified === true
        ? { checkedAt: new Date().toISOString(), status: 'unverified' }
        : await probeHttpCapability(item, options.botId)
    }
    return rt.skillQueue(item.name, async () => {
      const beforeCommit = () => {
        checkLibraryTarget(item.name, previous, team)
        if (previous && !options.ui) editCheck(previous, options.botId, 'change')
        if (item.kind === 'pack') checkPackItems(item.items, library())
      }
      beforeCommit()
      await skills.recoverDelete(item.name, team)
      beforeCommit()
      options.admit?.(item)
      const change = snapshot => { snapshot.capabilities.items[item.name] = item }
      await rt.saveCopy(change, { beforeCommit, afterWrite: () => change(state) })
      return item
    })
  }
  const capabilityDelete = async (name, { botId, ui, expect } = {}) => {
    if (expect !== undefined) expect = skillDeleteBinding(expect)
    await rt.load()
    const key = String(name ?? '')
    const authorize = current => { if (!ui) editCheck(current, botId, 'delete') }
    if (expect !== undefined) {
      if (!skillName(name)) throw skillRefusal('changed-elsewhere')
      return skills.deleteSkill(name, current => {
        writeCheck()
        authorize(current)
      }, expect)
    }
    writeCheck()
    const item = own(ensureLibrary(), key)
    if (!item) throw refusal(`No capability named ${name}.`)
    if (item.kind === 'skill' && skillName(name)) {
      return skills.deleteSkill(name, current => {
        if (current?.kind !== 'skill') throw refusal(`No capability named ${name}.`)
        authorize(current)
      })
    }
    const team = rt.teamGeneration()
    const remove = async () => {
      const beforeCommit = () => {
        checkLibraryTarget(key, item, team)
        authorize(item)
      }
      beforeCommit()
      const change = snapshot => deleteFrom(snapshot, key)
      await rt.saveCopy(change, { beforeCommit, afterWrite: () => change(state) })
      if (item.kind === 'skill') await rt.removeSkillLearning?.(key, () => {
        if (!rt.sameTeam(team) || !rt.teamCurrent() || own(library(), key) !== undefined) throw skillRefusal('changed-elsewhere')
      })
      return true
    }
    return skillName(key) ? rt.skillQueue(key, remove) : remove()
  }
  // Called after the Bot leaves the team. The shared library belongs to the user:
  // only an attached, unapproved local MCP this Bot verifiably requested goes.
  // Unmarked legacy entries have uncertain provenance and always stay.
  // A pack keeps its members even when no Bot currently has that pack attached.
  const dropOrphanCapabilities = (bot) => {
    const items = library()
    const packed = name => Object.values(items).some(item => item.kind === 'pack' && (item.items ?? []).includes(name))
    for (const name of bot.capabilities ?? []) {
      const item = own(items, name)
      if (item === undefined || item.kind !== 'mcp' || item.transport !== 'stdio' || item.approved === true) continue
      if (item.botRequested !== true) continue
      if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue
      delete items[name]
    }
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw refusal('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw refusal(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && !rt.isMain(callerId)) throw refusal('Only a Main Bot can change another Bot’s capabilities.')
    const item = own(ensureLibrary(), String(name ?? ''))
    if (!item) throw refusal(`No capability named ${name}.`)
    await setAttached(target, item.name, endpoint === 'attach')
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  // Changes one name against the saved list, so two quick changes both land.
  const setAttached = async (bot, name, attached) => {
    bot.capabilities ??= []
    const wasEmpty = bot.capabilities.length === 0
    if (attached && !bot.capabilities.includes(name)) bot.capabilities.push(name)
    if (!attached) bot.capabilities = bot.capabilities.filter(entry => entry !== name)
    await rt.save()
    if (wasEmpty && bot.capabilities.length > 0) {
      await trackBotAgents(bot)
      void scheduleReconcile()
    }
    return bot.capabilities
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
    grantStatuses.delete(sessionId)
  }
  // A Bot's mount reports under its Bot; a Session mount under its Session.
  const setStatus = (owner, name, sessionId, status) => {
    if (owner.botId !== undefined) return statusSet(owner.botId, name, sessionId, status)
    let byName = grantStatuses.get(sessionId)
    if (!byName) grantStatuses.set(sessionId, byName = new Map())
    byName.set(name, status)
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }
  const capabilityStatusesView = () => {
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      for (const name of bot.capabilities ?? []) {
        const item = own(library(), name)
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const status = children.find(status => status.state === 'error')
          ?? children.find(status => status.state === 'needs-approval')
          ?? children.find(status => status.state === 'connecting')
          ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    return result
  }
  const libraryView = () => Object.entries(library()).map(([name, item]) => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(Array.isArray(item.items) ? { items: [...item.items] } : {}),
    ...(item.kind === 'skill' ? {
      name,
      recordId: skillRecordId(item),
      ...(Array.isArray(item.files) ? { files: item.files.map(file => ({ ...file })) } : {}),
      ...(item.source ? { source: { ...item.source } } : {}),
      status: rt.skillDelivery(name).status,
    } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw refusal('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  // A Session that belongs to a Bot (its chat, a group, a task or run, an earlier part, or a
  // subagent of one) never takes a Session mount.
  // Another plugin's own Session that it names to the team (rt.hooks.sessionOwner) stays its own.
  const botOwned = (sessionId) => {
    if (rt.selfOf(sessionId) !== undefined) return true
    const owner = rt.teamOwnerOf?.(sessionId)
    return owner !== undefined && owner.kind !== 'hook'
  }
  // A Bot mount resolves the secrets the Bot's scope gives it. A Session mount resolves only a
  // secret its live grant names and that is scoped to that one Session, never one a Bot may use.
  const mayResolve = (name, owner) => {
    if (owner.botId !== undefined) return rt.canUseSecret(name, owner.botId)
    return owner.grant !== undefined && grants.get(owner.sessionId)?.get(owner.name) === owner.grant
      && owner.grant.secrets.has(name) && rt.canUseSecretInSession(name, owner.sessionId) && !botOwned(owner.sessionId)
  }
  function secretFor(name, owner) {
    const value = mayResolve(name, owner) ? rt.secretValue(name) : undefined
    if (value === undefined) throw refusal(rt.secretHeldReason?.(name) ?? `Secret ${name} is missing or unavailable for this ${owner.botId !== undefined ? 'Bot' : 'Session'}.`)
    return value
  }
  function resolveValues(values, owner) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, owner))
    }
    return resolved
  }
  const resolveUrl = (url, owner) => String(url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(secretFor(name, owner)))
  const resolveList = (list, owner) => (list ?? []).map(raw => String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, owner)))
  const configFor = (item, owner) => {
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: resolveList(item.args, owner), env: resolveValues(item.env, owner), failOnStartupError: true }
    return { transport: 'streamable-http', serverName: item.name, url: resolveUrl(item.url, owner), headers: resolveValues(item.headers, owner), failOnStartupError: true }
  }
  // Every secret an MCP item names where the mount resolves them.
  const referencedSecrets = (item) => {
    const texts = item.transport === 'stdio'
      ? [...(item.args ?? []), ...Object.values(item.env ?? {})]
      : [item.url, ...Object.values(item.headers ?? {})]
    return new Set(texts.flatMap(text => [...String(text ?? '').matchAll(SECRET_REFERENCE)].map(match => match[1])))
  }
  // A Bot resolves only the secrets it may use; the operator saving from Settings resolves a
  // stored secret only when some Bot could use it, and the value only ever goes to the URL.
  const probeSecret = (name, botId) => {
    const usable = botId === undefined
      ? Object.values(state.bots).some(bot => rt.canUseSecret(name, bot.id))
      : rt.canUseSecret(name, botId)
    const value = usable ? rt.secretValue(name) : undefined
    if (value === undefined) throw refusal(rt.secretHeldReason?.(name) ?? `Secret ${name} is missing or unavailable${botId === undefined ? '' : ' for this Bot'}.`)
    return value
  }
  // One initialize POST, with the headers the mount would send. Redact before truncating, so a
  // secret cut at the excerpt edge cannot survive as a fragment.
  const probeHttpCapability = async (item, botId) => {
    const checkedAt = new Date().toISOString()
    let url
    let headers
    let sent
    try {
      const resolved = resolveProbeHeaders(item.headers, botId)
      sent = Object.values(resolved).filter(value => value !== '').sort((a, b) => b.length - a.length)
      url = String(item.url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(probeSecret(name, botId)))
      headers = { ...resolved, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    } catch (error) {
      return { checkedAt, status: 'unverified', reason: rt.redactSecrets(String(error?.message ?? error)).slice(0, PROBE_REASON_CHARS) }
    }
    // The redactor goes first, over the whole text, and here it replaces every known value
    // wherever it sits, even a 4-7 character one inside a run of letters: a stored secret is
    // replaced whole, so no edge of it can survive. Scrub the sent header values only after
    // that, and only where a secret did not already cover them: scrubbing first would cut a
    // secret around a header value that is a substring of it and leave that secret's prefix
    // and suffix behind. A header that embeds a secret therefore reads as [secret:NAME], not
    // [header]; the label is secondary. Truncation happens only after both, so a cap cannot
    // split a secret.
    const clean = (text) => {
      let out = rt.redactSecretsAnywhere(String(text ?? ''))
      for (const value of sent) out = out.split(value).join('[header]')
      return out.replace(/\s+/g, ' ').trim()
    }
    let response
    try {
      // Never follow a redirect: the second origin would receive the headers, and a GET would
      // hide a POST the capability never made. One request, and a 3xx is the verdict.
      response = await fetch(url, {
        method: 'POST', headers, body: PROBE_BODY, redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      const reason = timedOut ? `timed out after ${PROBE_TIMEOUT_MS / 1000}s` : `could not reach the server: ${clean(error?.message ?? error)}`
      return { checkedAt, status: 'unverified', reason: reason.slice(0, PROBE_REASON_CHARS) }
    }
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel() } catch { /* the status is the verdict */ }
      const reason = `HTTP ${response.status} (a redirect is not followed)`
      return { checkedAt, status: 'unverified', reason: reason.slice(0, PROBE_REASON_CHARS) }
    }
    if (response.status === 401 || response.status === 403) {
      let excerpt = ''
      try { excerpt = clean(await response.text()).slice(0, PROBE_EXCERPT_CHARS) } catch { /* the status is the verdict */ }
      const challenge = clean(response.headers.get('www-authenticate') ?? '')
        .slice(0, PROBE_EXCERPT_CHARS) || '(none)'
      throw refusal(`Not saved: ${item.name} answered HTTP ${response.status} (WWW-Authenticate: ${challenge}; body: ${excerpt || '(empty)'}). A capability stores headers only and has no sign-in flow. To keep it anyway, use Save unverified in Settings > Capabilities.`)
    }
    if (response.ok) {
      try { await response.body?.cancel() } catch { /* the status is the verdict */ }
      return { checkedAt, status: 'verified' }
    }
    let reason = `HTTP ${response.status}`
    try {
      const excerpt = clean(await response.text()).slice(0, PROBE_EXCERPT_CHARS)
      if (excerpt !== '') reason += `: ${excerpt}`
    } catch { /* the status is the verdict */ }
    return { checkedAt, status: 'unverified', reason: reason.slice(0, PROBE_REASON_CHARS) }
  }
  const resolveProbeHeaders = (values, botId) => {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => probeSecret(name, botId))
    }
    return resolved
  }
  const disposeMount = async mount => {
    if (mount) mount.retired = true
    mount?.unregister?.()
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  // One capability into one Agent, for its Bot ({ botId }) or for its Session alone
  // ({ sessionId }: a Session mount, which resolves secrets through its grant).
  const mountOne = async (agent, mountFor, agentMounts, name) => {
    const sessionId = agent.session.id
    const owner = mountFor.botId !== undefined ? mountFor : { sessionId, name, grant: grants.get(sessionId)?.get(name) }
    await rt.skillsReady()
    const item = own(library(), name)
    if (item?.kind === 'skill' && capturesSkills(agent)) return reconcileAfterTurn(agent)
    const drop = async () => {
      const mount = agentMounts.get(name)
      agentMounts.delete(name)
      await disposeMount(mount)
    }
    if (!item) return drop()
    const suspended = async () => {
      await drop()
      setStatus(owner, name, sessionId, { state: 'error', error: runnerWarning(name).message })
    }
    if (needsRunner(item, sessionId, agent)) return suspended()
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      setStatus(owner, name, sessionId, { state: 'needs-approval' })
      return
    }
    // A Session mount runs only what the person saved: once a Bot changes it, it stops until
    // the person saves it again in Settings.
    if (owner.botId === undefined && item.fromSettings !== true) {
      await drop()
      setStatus(owner, name, sessionId, { state: 'error', error: SAVED_BY_BOT(name) })
      return
    }
    let config
    try {
      if (item.kind === 'skill') {
        const { snapshot } = rt.skillDelivery(name)
        if (!snapshot) {
          await drop()
          setStatus(owner, name, sessionId, { state: 'error', error: 'This skill is held until it passes the skill check.' })
          return
        }
        config = { name, description: snapshot.skillMd.description, content: snapshot.skillMd.body, hash: snapshot.hash }
      } else config = configFor(item, owner)
    } catch (error) {
      await drop()
      setStatus(owner, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
      return
    }
    const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
    if (agentMounts.get(name)?.key === key) return
    await drop()
    setStatus(owner, name, sessionId, { state: 'connecting' })
    const mount = { key, hash: item.kind === 'skill' ? config.hash : undefined }
    try {
      const plugin = item.kind === 'skill'
        ? {
          name: `ds-bot-capability-skill-${name}`,
          inject: ['skills'],
          apply(c) {
            c.effect(() => {
              if (mount.retired) return
              const unregister = c.skills.register({ name: config.name, description: config.description, source: 'runtime', content: config.content })
              mount.unregister = () => {
                mount.unregister = undefined
                unregister()
              }
              return () => mount.unregister?.()
            })
          },
        }
        : await loadMcpPlugin()
      if (stopped) return
      if (item.kind === 'skill' && capturesSkills(agent)) return reconcileAfterTurn(agent)
      if (needsRunner(item, sessionId, agent)) return suspended()
      const fiber = item.kind === 'skill' ? agent.ctx.plugin(plugin) : agent.ctx.plugin(plugin, config)
      mount.fiber = fiber
      agentMounts.set(name, mount)
      await fiber.await()
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      setStatus(owner, name, sessionId, { state: 'ready' })
    } catch (error) {
      await drop()
      const message = rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'Connection failed').slice(0, 300)
      setStatus(owner, name, sessionId, { state: 'error', error: message })
    }
  }
  // The Session mounts still granted for a Session. A grant whose capability was deleted, or
  // is no longer an MCP server, ends with it, and so does the scope of its secrets.
  const grantedNames = (sessionId) => {
    const names = new Set()
    for (const [name, grant] of grants.get(sessionId) ?? []) {
      if (own(library(), name)?.kind === 'mcp') {
        names.add(name)
        continue
      }
      void endGrant(sessionId, name, grant)
    }
    return names
  }
  const reconcileAgent = async (agent, bot) => {
    const sessionId = agent.session.id
    const desired = bot ? expandCapabilityNames(bot.capabilities, library()) : grantedNames(sessionId)
    const agentMounts = mounts.get(agent) ?? new Map()
    if (desired.size > 0) mounts.set(agent, agentMounts)
    if (bot) {
      for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
        if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
      }
    } else {
      const statuses = grantStatuses.get(sessionId)
      clearSession(sessionId)
      for (const [name, status] of statuses ?? []) if (desired.has(name)) setStatus({ sessionId }, name, sessionId, status)
    }
    for (const [name, mount] of agentMounts) {
      if (desired.has(name)) continue
      if (mount.hash !== undefined && capturesSkills(agent)) {
        reconcileAfterTurn(agent)
        continue
      }
      await disposeMount(mount)
      agentMounts.delete(name)
    }
    const mountFor = bot ? { botId: bot.id } : { sessionId }
    await Promise.all([...desired].map(name => mountOne(agent, mountFor, agentMounts, name)))
    if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent)
  }
  const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
  // At most one run waits behind the running one; it reads the latest state when it starts.
  const reconcileOne = agent => {
    if (queued.has(agent)) return chains.get(agent)
    queued.add(agent)
    const run = (chains.get(agent) ?? Promise.resolve()).then(async () => {
      queued.delete(agent)
      const sessionId = agent.session.id
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      await reconcileAgent(agent, botOfSession(sessionId))
    }).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', agent.session?.id, error))
    chains.set(agent, run)
    return run
  }
  const loadInputs = async () => {
    await rt.load()
    loadingSecrets += 1
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets -= 1
    }
  }
  async function reconcile() {
    if (stopped) return
    await loadInputs()
    await rt.skillsReady()
    const runs = []
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (agent) {
        runs.push(reconcileOne(agent))
        continue
      }
      agents.delete(sessionId)
      clearSession(sessionId)
    }
    await Promise.all(runs)
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        scheduled = null
        resolve(reconcile().catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error)))
      }))
    }
    return scheduled
  }
  // A run that outlasts the limit goes on in the background, and later requests for the
  // same Agent do not wait for it again.
  const stalled = new WeakSet()
  const prepare = async (agent, sessionId) => {
    const run = loadInputs().then(() => reconcileOne(agent)).then(() => true, error => {
      rt.warn('ds-bot: capability mount for %s failed: %s', sessionId, error)
      return true
    })
    if (stalled.has(agent)) return
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false) })])
    clearTimeout(timer)
    if (completed) return
    stalled.add(agent)
    void run.then(() => stalled.delete(agent))
    rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) return
    if ((bot.capabilities ?? []).length === 0 && !mounts.get(agents.get(sessionId)?.deref())?.size) return
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    trackAgent(agent)
    await prepare(agent, sessionId)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) agents.delete(sessionId)
      clearSession(sessionId)
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
    }, `ds-bot: capabilities ${sessionId}`)
  }
  // Ends one grant. Nothing resolves its secrets from here on (mayResolve wants the live
  // grant); its mount goes at the Session's next reconcile, and each of its secrets that no
  // other grant of the Session names goes back to no Session.
  const endGrant = async (sessionId, name, grant) => {
    const byName = grants.get(sessionId)
    if (byName?.get(name) !== grant) return false
    byName.delete(name)
    if (byName.size === 0) grants.delete(sessionId)
    grantStatuses.get(sessionId)?.delete(name)
    const kept = new Set([...byName.values()].flatMap(other => [...other.secrets]))
    const free = [...grant.secrets].filter(secret => !kept.has(secret))
    if (free.length > 0) {
      await rt.releaseSessionSecrets(free, sessionId)
        .catch(error => rt.warn('ds-bot: secrets of %s stay scoped to Session %s: %s', name, sessionId, error?.message ?? error))
    }
    return true
  }
  const grantSecretsOf = (grant) => {
    const list = grant?.secrets ?? []
    if (!Array.isArray(list) || list.some(name => typeof name !== 'string')) throw refusal('grant.secrets must be a list of secret names.')
    return new Set(list)
  }
  const mountView = (sessionId, name) => {
    const status = grantStatuses.get(sessionId)?.get(name) ?? { state: 'connecting' }
    return { sessionId, name, state: status.state, ...(status.error ? { error: status.error } : {}), toolPrefix: `mcp__${name}__` }
  }
  // Another plugin mounts one MCP capability into one plain Session it owns (an answer
  // thread, for one person), and only there: its tools go into that Session's Agent scope,
  // and the secrets it uses are scoped to that Session (secrets.js bindSessionSecrets).
  async function mountCapability(sessionId, name, grant = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') throw refusal('Name the Session to mount the capability into.')
    if (stopped) throw refusal('The Bot team has stopped.')
    await loadInputs()
    if (botOwned(sessionId)) throw refusal('This Session belongs to a Bot. A Bot takes capabilities through its own list, never through a Session mount.')
    const item = own(library(), String(name ?? ''))
    if (!item) throw refusal(`No capability named ${name}.`)
    if (item.kind !== 'mcp') throw refusal(`${item.name} is not an MCP server. Only an MCP server mounts into one Session.`)
    if (item.fromSettings !== true) throw refusal(SAVED_BY_BOT(item.name))
    const secrets = grantSecretsOf(grant)
    const used = referencedSecrets(item)
    const missing = [...used].filter(secret => !secrets.has(secret))
    if (missing.length > 0) throw refusal(`${item.name} uses ${missing.join(', ')}; the grant must name ${missing.length === 1 ? 'it' : 'them'}.`)
    const unused = [...secrets].filter(secret => !used.has(secret))
    if (unused.length > 0) throw refusal(`${item.name} does not use ${unused.join(', ')}.`)
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      throw refusal(`Session ${sessionId} is not available: ${rt.redactSecrets(String(error?.message ?? error)).slice(0, 300)}`)
    }
    if (stopped) throw refusal('The Bot team has stopped.')
    if (needsRunner(item, sessionId, agent)) throw runnerWarning(item.name)
    await rt.bindSessionSecrets([...secrets], sessionId)
    let byName = grants.get(sessionId)
    if (!byName) grants.set(sessionId, byName = new Map())
    const previous = byName.get(item.name)
    const same = previous !== undefined && previous.secrets.size === secrets.size && [...secrets].every(secret => previous.secrets.has(secret))
    if (!same) {
      byName.set(item.name, { secrets })
      // A grant that now names fewer secrets frees those no grant of the Session still names.
      const kept = new Set([...byName.values()].flatMap(other => [...other.secrets]))
      const dropped = [...(previous?.secrets ?? [])].filter(secret => !kept.has(secret))
      if (dropped.length > 0) {
        await rt.releaseSessionSecrets(dropped, sessionId)
          .catch(error => rt.warn('ds-bot: secrets of %s stay scoped to Session %s: %s', item.name, sessionId, error?.message ?? error))
      }
    }
    trackAgent(agent)
    await prepare(agent, sessionId)
    return mountView(sessionId, item.name)
  }
  // Withdraws a Session mount: nothing resolves its secrets from then on, its mount goes, and
  // the Session scope of its secrets ends. The saved scope ends also with no live mount (after
  // a restart there is none): the secrets the capability uses, or, when it is gone, each
  // secret scoped to the Session that no saved capability and no live mount there still use.
  // True when a mount or a scope ended.
  async function unmountCapability(sessionId, name) {
    if (typeof sessionId !== 'string' || sessionId === '') throw refusal('Name the Session to unmount the capability from.')
    const key = String(name ?? '')
    const grant = grants.get(sessionId)?.get(key)
    let ended = false
    if (grant !== undefined) {
      const agent = agents.get(sessionId)?.deref()
      const ending = endGrant(sessionId, key, grant)
      if (agent !== undefined) await reconcileOne(agent)
      ended = await ending
    }
    await rt.load()
    const item = own(library(), key)
    const live = new Set([...(grants.get(sessionId)?.values() ?? [])].flatMap(other => [...other.secrets]))
    let scoped
    if (item?.kind === 'mcp') {
      scoped = [...referencedSecrets(item)]
    } else {
      // The capability is gone: only the Session's keys that no saved MCP capability still uses.
      const used = new Set(Object.values(library()).filter(other => other.kind === 'mcp').flatMap(other => [...referencedSecrets(other)]))
      scoped = (await rt.sessionSecretNames(sessionId, { stored: true })).filter(secret => !used.has(secret))
    }
    const free = scoped.filter(secret => !live.has(secret))
    const released = free.length > 0 && await rt.releaseSessionSecrets(free, sessionId)
    return ended || released
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  async function capabilityEndpoint(endpoint, body = {}, attachment) {
    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const name = String(body.name ?? '')
      const item = own(library(), name)
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw refusal(`No unapproved stdio MCP named ${body.name}.`)
      const team = rt.teamGeneration()
      const approve = async () => {
        const beforeCommit = () => checkLibraryTarget(name, item, team)
        beforeCommit()
        const approved = { ...item, approved: true, updatedAt: Date.now() }
        const change = snapshot => { snapshot.capabilities.items[name] = approved }
        await rt.saveCopy(change, { beforeCommit, afterWrite: () => change(state) })
        return approved
      }
      return skillName(name) ? rt.skillQueue(name, approve) : approve()
    }
    if (endpoint === 'bot-capability') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw refusal('Unknown Bot')
      const name = String(body.name ?? '')
      if (attachment && (!rt.sameTeam(attachment.team) || own(library(), name) !== attachment.item)) throw skillRefusal('changed-elsewhere')
      if (!own(library(), name)) throw refusal(`No capability named ${name}.`)
      return setAttached(bot, name, body.attached === true)
    }
    throw refusal('Unknown capability operation.')
  }
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsChanged?.()
    if (loadingSecrets === 0) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => { void scheduleReconcile() }
  // Creation waits for these listeners, so a new Agent's first request already has its
  // tools. The skill catalog is read later, inside DSH's pre-step middleware.
  ctx.on('agent/created', async function prepareCapabilities({ agent }) {
    trackAgent(agent)
    try {
      await rt.load()
      await rt.skillsReady()
      const bot = botOfSession(agent.session.id)
      // A Session mount follows its Session to each new Agent (a clear, a compaction).
      if ((bot?.capabilities ?? []).length > 0 || (!bot && grants.has(agent.session.id))) await prepare(agent, agent.session.id)
    } catch (error) {
      rt.warn('ds-bot: capability load failed: %s', error)
    }
  })
  ctx.on('agent/pre-step', function admitSkills({ agent, turn }, next) {
    if (turn !== undefined && admittedTurns.get(agent) === turn) return next()
    if (turn !== undefined) admittedTurns.set(agent, turn)
    const mounted = mounts.get(agent)
    if (mounted) {
      let desired
      try {
        const bot = botOfSession(agent.session.id)
        if (bot) desired = expandCapabilityNames(bot.capabilities, library())
      } catch { /* withhold if current memberships cannot be resolved */ }
      for (const [name, mount] of mounted) {
        if (mount.hash === undefined) continue
        let verified = false
        try {
          verified = desired?.has(name) && rt.teamCurrent() && rt.skillDelivery(name).snapshot?.hash === mount.hash
        } catch { /* withhold on failure */ }
        if (verified) continue
        mounted.delete(name)
        mount.unregister?.()
        void disposeMount(mount)
        reconcileAfterTurn(agent)
      }
    }
    return next()
  }, { prepend: true })
  // A Session that closes takes its Session mounts with it; the Session scope of their
  // secrets stays, so after this only that Session can mount them again.
  ctx.on('session/disposed', function releaseSessionMounts(session) {
    const sessionId = session?.id
    if (!grants.has(sessionId)) return
    grants.delete(sessionId)
    grantStatuses.delete(sessionId)
    const agent = agents.get(sessionId)?.deref()
    if (agent !== undefined) void reconcileOne(agent)
  })
  ctx.effect(() => {
    const unregister = rt.onLockGained(() => { void scheduleReconcile() })
    void rt.load().then(async () => {
      await rt.skillsReady()
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return async () => {
      stopped = true
      unregister()
      const live = [...mounts.values()]
      mounts.clear()
      agents.clear()
      sessionStatuses.clear()
      grants.clear()
      grantStatuses.clear()
      await Promise.all(live.flatMap(agentMounts => [...agentMounts.values()].map(disposeMount)))
    }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    skillMountRoots(name) {
      const roots = new Set()
      for (const [agent, mounted] of mounts) {
        const mount = mounted.get(name)
        if (mount?.hash && capturesSkills(agent)) roots.add(mount.hash)
      }
      return roots
    },
    dropOrphanCapabilities,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
    mountCapability,
    unmountCapability,
  })
}
