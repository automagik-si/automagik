import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { HermesTransport, RemoteChat, remoteAddress, HERMES_DEADLINES } from './hermes-transport.js'
import { attachedModelOf, prepareHermesConnection, refreshHermesProfiles } from './hermes-connection.js'
import { discoverSshHosts } from './hermes-ssh-hosts.js'
import { redactSshNames } from './hermes-ssh-names.js'
import { HERMES_MINIMUM, hermesSshDestination } from './hermes-ssh.js'
import { MISSING_TOOLS, RemoteChatAdapter } from './remote-chat-adapter.js'
import { refusal } from './refusal.js'

export const HERMES_PROVIDER = 'hermes-remote'
const CREDENTIAL_REF = 'HERMES_REMOTE_CREDENTIAL'
const ATTACH_CREDENTIAL_REF = 'HERMES_REMOTE_ATTACH_CREDENTIAL'
const TEST_LIFETIME = 5 * 60_000
const CHAT_BUSY = 'A chat is still running on this connection; stop it or wait.'
const fail = (message, kind = 'connection') => refusal(message, { code: `bot/hermes-${kind}` })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const extraHomes = value => (Array.isArray(value) ? value : []).slice(0, 20).filter(path => typeof path === 'string' && path.startsWith('/') && path.length <= 4096 && !/[\x00-]/.test(path) && !path.split('/').includes('..'))
const sshFields = ssh => Object.fromEntries(['host', 'user', 'port', 'identityFile', 'hermesPath', 'hermesHome', 'recordDir'].filter(key => ssh?.[key] !== undefined).map(key => [key, ssh[key]]))
const shq = value => /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`
function startLine(config) {
  const home = config.ssh?.hermesHome
  return typeof home === 'string' && home.startsWith('/') ? `HERMES_HOME=${shq(home)} hermes serve` : 'hermes serve'
}
const CONNECTION_ERRORS = Object.freeze({
  'bot/hermes-busy': CHAT_BUSY,
  'bot/hermes-pairing': 'The Hermes Bot pairing could not be verified. Check the selected profile and its existing Bot Chat.',
  'bot/hermes-shell': 'That Bot has no shell, so it cannot be paired with Remote Hermes, whose own tools can run commands. Turn its shell on first.',
  'bot/hermes-auth': 'Hermes did not accept the saved sign-in. Check the token or sign in again.',
  'bot/hermes-connection': 'Remote Hermes could not connect. Check the connection details and try again.',
  'bot/hermes-profiles': 'Hermes could not open the selected profile. Check its available profiles and try again.',
  'bot/hermes-attach-profile': 'This connection’s saved Hermes profile is not served there. Choose a profile again before connecting.',
  'bot/hermes-expired': 'This connection waited too long and was closed. Connect again.',
  'bot/hermes-unsupported': 'This Hermes is run by a gateway that owns its sessions. Connect to a Hermes started with “hermes serve”.',
  'bot/hermes-outdated': 'Remote Hermes is too old for this connection. Update Hermes, then connect again.',
  'bot/hermes-protocol': 'Remote Hermes returned an invalid protocol frame. Reconnect and reconcile the remote session.',
  'bot/hermes-timeout': 'Hermes did not answer in time. Check the connection and try again.',
  'bot/hermes-ssh': 'SSH could not connect. Check the connection details and try again.',
  'bot/hermes-ssh-host-key': 'Verify this computer’s SSH host key in a terminal before connecting again.',
  'bot/hermes-ssh-auth': 'SSH could not sign in. Check the user and key, then try again.',
  'bot/hermes-ssh-missing': 'SSH could not find Hermes. Install Hermes or enter its executable path.',
  'bot/hermes-ssh-interactive': 'SSH needs interactive sign-in. Unlock the key in your SSH agent, then try again.',
  'bot/hermes-ssh-update': 'The remote Hermes needs an update before it can connect.',
  'bot/hermes-ssh-version': 'The remote Hermes did not report a release number. Update it, then try again.',
  'bot/hermes-ssh-platform': 'This remote platform does not support the Hermes SSH connection.',
  'bot/hermes-ssh-timeout': 'SSH did not answer in time. Check the connection and try again.',
  'bot/hermes-ssh-unreachable': 'SSH could not reach the other computer. Check the host and connection.',
  'bot/hermes-ssh-cleanup': 'The SSH connection could not confirm remote cleanup. Check the remote Hermes before reconnecting.',
  'bot/hermes-attach-not-running': 'Hermes is not running on the other computer. Start it there with “hermes serve”, then try again.',
  'bot/hermes-attach-gateway-running': 'Hermes is running on the other computer as a gateway, but no “hermes serve” is running. Start “hermes serve” there, then try again.',
  'bot/hermes-attach-gateway': 'Hermes is running there as a gateway that owns its sessions. Start “hermes serve” there, then try again.',
  'bot/hermes-attach-record': 'Hermes is not running there: its connection record or private token is stale. Start “hermes serve” there, then try again.',
  'bot/hermes-attach-profiles': 'Hermes is running there, but its profiles could not be read. Run “hermes profile list” there, then try again.',
  'bot/hermes-ssh-host-key-unknown': 'This computer has not connected to this SSH host before. Check its host key and trust it before connecting again.',
  'bot/hermes-ssh-exited': 'Hermes stopped on the other computer before it was ready.',
  'bot/hermes-ssh-not-ready': 'Hermes started on the other computer but was not ready in time.',
  'bot/hermes-ssh-port': 'Hermes started on the other computer but did not report its port.',
  'bot/hermes-ssh-handshake': 'The private start handshake with the other computer failed.',
  'bot/hermes-ssh-tunnel': 'The SSH tunnel to the remote Hermes did not start.',
  'bot/hermes-ssh-forward': 'A port forward from this host’s own SSH config could not start.',
  'bot/hermes-ssh-script': 'The start script stopped on the other computer.',
  'bot/hermes-ssh-details': 'Enter valid SSH details.',
})
const FAILURE_LIFETIME = 10 * 60_000
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined
const profileText = value => text(value, 100) && value.trim() === value && !/[\/\\]/.test(value) ? value : undefined
function profileOf(value) {
  const id = profileText(value?.id), name = profileText(value?.name)
  return id ? { id, ...(name && name !== id ? { name } : {}) } : undefined
}
function savedProfileOf(config) {
  const id = profileText(config?.profile)
  const row = id && Array.isArray(config?.profiles) ? config.profiles.find(row => row?.id === id) : undefined
  return profileOf({ id, name: row?.name })
}
function attachProfileRefusal(profile) {
  if (!profile) return fail(CONNECTION_ERRORS['bot/hermes-attach-profile'], 'attach-profile')
  const label = profile.name ? `${profile.name} (${profile.id})` : profile.id
  return Object.assign(fail(`This connection’s saved Hermes profile “${label}” is not served there. Choose a profile again before connecting.`, 'attach-profile'), { hermesProfile: profile })
}
const NO_ALIAS = '(none)'
const strings = value => Array.isArray(value) ? value.filter(name => typeof name === 'string' && name.length > 0 && name.length <= 255).slice(0, 16) : []
const lines = value => Array.isArray(value) ? value.filter(line => typeof line === 'string').slice(-8).map(line => line.slice(0, 240)) : []
// What the person's own screen may show of one failed SSH connection. Every line was
// already cleaned of this connection's secrets where SSH and Hermes said it.
function failureView(error, alias, elapsedMs, stage) {
  const detail = error?.sshDetail ?? {}, code = typeof error?.code === 'string' ? error.code : 'bot/refused'
  const view = { code, kind: text(error?.sshError, 40) ?? (code.replace(/^bot\/(?:hermes-?)?/, '') || 'unknown'), stage, alias, elapsedMs }
  const profile = profileOf(error?.hermesProfile)
  if (profile) { view.profile = profile.id; if (profile.name) view.profileName = profile.name }
  if (Number.isSafeInteger(detail.exit)) view.exit = detail.exit
  for (const key of ['ssh', 'hermes']) if (lines(detail[key]).length) view[key] = lines(detail[key])
  for (const key of ['keyType', 'fingerprint', 'fault']) if (text(detail[key], 100)) view[key] = detail[key]
  if (Array.isArray(detail.identities)) view.identities = detail.identities.filter(name => text(name, 64)).slice(0, 6)
  for (const key of ['agentKeys', 'port', 'errno', 'line']) if (Number.isSafeInteger(detail[key]) && detail[key] > 0) view[key] = detail[key]
  for (const key of ['unsaved', 'mismatch']) if (detail[key] === true) view[key] = true
  // The release Hermes reported, the oldest one this adapter speaks to, and the install kind.
  for (const key of ['version', 'minimum']) if (/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(detail[key] ?? '')) view[key] = detail[key]
  if (/^[a-z0-9-]{1,32}$/.test(detail.install ?? '')) view.install = detail.install
  return view
}
// The one diagnostics line of a failed SSH connection. No identity file name and no
// host key: the person's screen has those, a report does not need them. The line may be
// attached to a report, so it names no one: `storedView` is what it is made from.
const failureLine = view => [`Remote Hermes SSH failed: alias=${view.alias} stage=${view.stage} kind=${view.kind} elapsed=${view.elapsedMs}ms`,
  view.exit !== undefined ? `exit=${view.exit}` : '', view.version ? `version=${view.version}` : '', view.minimum ? `minimum=${view.minimum}` : '', view.install ? `install=${view.install}` : '', view.fault ? `fault=${view.fault}${view.errno ? `/${view.errno}` : ''}${view.line ? `@${view.line}` : ''}` : '', view.port ? `port=${view.port}` : '',
  view.ssh ? `ssh=${JSON.stringify(view.ssh.join(' | '))}` : '', view.hermes ? `hermes=${JSON.stringify(view.hermes.join(' | '))}` : ''].filter(Boolean).join(' ')
// The view as a stored line may show it: the alias the person typed, the remote user,
// the host and every address become placeholders. The screen keeps the view itself.
function storedView(view, ssh, origin) {
  const names = { alias: view.alias === NO_ALIAS ? undefined : view.alias, hosts: strings(origin?.sshNames?.hosts), users: [...strings(origin?.sshNames?.users), ...strings([ssh?.user])] }
  const stored = { ...view, alias: names.alias ? '<alias>' : NO_ALIAS }
  // Profile labels belong on the person's screen, never in the SSH report.
  delete stored.profile; delete stored.profileName
  for (const key of ['ssh', 'hermes']) if (view[key]) stored[key] = view[key].map(line => redactSshNames(line, names))
  return stored
}
const connectionFailure = (error, native = false) => error?.cleanupUnknown === true
  ? refusal(CONNECTION_ERRORS['bot/hermes-ssh-cleanup'], { code: 'bot/hermes-ssh-cleanup' })
  : error?.code === 'bot/hermes-attach-profile'
  ? attachProfileRefusal(profileOf(error.hermesProfile))
  : Object.hasOwn(CONNECTION_ERRORS, error?.code)
  ? refusal(CONNECTION_ERRORS[error.code], { code: error.code })
  : refusal(native && error?.code === 'bot/hermes' ? error.message : 'Remote Hermes could not connect.')

export function install(rt, { transport = options => new HermesTransport(options), fetch: fetcher = globalThis.fetch, startSsh, detectHermes = async (...args) => (await import('./hermes-detect.js')).detectHermesBots(...args), trustSsh = async (...args) => (await import('./hermes-ssh.js')).trustHermesSshHostKey(...args), sshHosts = discoverSshHosts, now = Date.now, deadlines = HERMES_DEADLINES, testLifetime = TEST_LIFETIME } = {}) {
  const { ctx, state } = rt
  // The last failed SSH connection of each wizard request, kept in memory for its own
  // screen (the stage, SSH's and Hermes's last lines, a new host key to trust).
  const failures = new Map()
  // `origin` is the error SSH itself threw: a failure shown as another one (unconfirmed
  // cleanup, a start deadline) still takes the connection's names from it.
  function noteSshFailure(key, ssh, error, started, origin = error) {
    const alias = text(typeof ssh?.host === 'string' ? ssh.host.trim() : '', 255) ?? NO_ALIAS
    const view = failureView(error, alias, Math.max(0, Date.now() - started), text(error?.sshStage ?? error?.hermesStage, 40) ?? 'connection')
    rt.noteFailure?.({ source: 'host', where: 'Remote Hermes', code: view.code, text: failureLine(storedView(view, ssh, origin)) })
    if (typeof key !== 'string' || !key || key.length > 100) return view
    failures.delete(key)
    failures.set(key, { view, ssh: sshFields(ssh), expires: Date.now() + FAILURE_LIFETIME })
    while (failures.size > 8) failures.delete(failures.keys().next().value)
    return view
  }
  const failureOf = key => {
    const entry = typeof key === 'string' ? failures.get(key) : undefined
    if (entry && entry.expires <= Date.now()) { failures.delete(key); return undefined }
    return entry
  }
  const record = () => state.prefs?.hermesRemote ?? { enabled: false, models: [] }
  // Every saved SSH connection is an attached connection now; records written before this
  // feature carry no `attached` flag. Their models/profiles are rebuilt from the live
  // connection on first use, never trusted from the old remote-address list.
  const attachedRecord = value => value?.mode === 'ssh' || value?.attached === true
  const attachedRows = (value, connection) => Array.isArray(connection?.profiles) ? connection.profiles
    : Array.isArray(value?.profiles) ? value.profiles : []
  const attachedModelFor = (value, connection) => {
    const rows = attachedRows(value, connection)
    // Only the saved profile may name this connection's model. If the serve no longer
    // offers it, the view shows none and normalizeAttached refuses; it must never borrow
    // another profile's Bot Chat by falling back to the first row.
    const row = rows.find(profile => profile.id === (value?.profile ?? ''))
    if (row) return attachedModelOf(row)
    const models = Array.isArray(value?.models) ? value.models : []
    return models.length === 1 && models[0]?.id === 'attach' ? models[0] : undefined
  }
  const attachedModelsCurrent = value => attachedRecord(value) && value?.models?.length === 1
    && value.models[0]?.id === 'attach' && Array.isArray(value?.profiles) && value.profiles.length > 0
  const sessions = () => state.hermesSessions ??= {}
  const enabled = () => record().enabled === true
  const identity = id => {
    const config = record(), paired = config.pairedBotId
    // An attached serve has one rolling Bot Chat per profile: every chat joins it, never
    // creates, renames or archives a conversation. Pairing still scopes the one Bot.
    if (attachedRecord(config)) {
      if (paired && rt.chatOwners?.get(id) !== paired) throw fail('This Hermes profile is paired to another Bot chat.', 'pairing')
      const key = paired ? `bot:${paired}` : id
      const joined = sessions()[key]
      if (joined) { joined.canonicalBot = true; return joined }
      return sessions()[key] = { canonicalBot: true }
    }
    if (paired) {
      // Only this bot's current own-chat segment may enter its forever-chat. Groups,
      // tasks and other bots must not leak their context into the paired identity.
      if (rt.chatOwners?.get(id) !== paired) throw fail('This Hermes profile is paired to another Bot chat.', 'pairing')
      return sessions()[`bot:${paired}`] ??= { canonicalBot: true }
    }
    return sessions()[id] ??= { createKey: randomUUID() }
  }
  // Identity-only persistence must not queue behind a Stop already awaited by
  // a connection mutation. The store serializes required writes itself.
  const saveState = () => rt.save({ required: true })
  const mutationScope = new AsyncLocalStorage(), intents = new Set()
  let mutationTail = Promise.resolve(), activeMutation
  const mutate = (work, internal = false) => {
    const owner = mutationScope.getStore()
    if (internal && owner && owner === activeMutation) return Promise.resolve().then(work)
    const next = mutationTail.then(() => {
      const token = {}
      return mutationScope.run(token, async () => {
        activeMutation = token
        try { return await work() } finally { if (activeMutation === token) activeMutation = undefined }
      })
    })
    mutationTail = next.catch(() => {})
    return next
  }
  const testMatches = (entry, body = {}) => entry
    && (body.testId === undefined || entry.id === body.testId || entry.testId === body.testId)
    && (body.requestId === undefined || entry.requestId === body.requestId)
  function interruptTests(body = {}) {
    if ((body.testId !== undefined && (typeof body.testId !== 'string' || !body.testId))
      || (body.requestId !== undefined && (typeof body.requestId !== 'string' || !body.requestId))) return
    let matched = false
    for (const intent of intents) if (intent.test && testMatches(intent, body) && (!intent.testId || tested?.id === intent.testId)) { matched = true; intent.controller.abort() }
    if (testMatches(tested, body)) { matched = true; tested.controller.abort() }
    if (testMatches(pendingTest, body)) { matched = true; pendingTest.controller.abort() }
    return matched
  }
  function waiting(task, startup, finish = true) {
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(fail('Connection setup was cancelled or timed out.', 'timeout'))
      startup.signal.addEventListener('abort', abort, { once: true })
      if (startup.signal.aborted) abort()
    })
    return Promise.race([task, cancelled]).finally(() => {
      startup.signal.removeEventListener('abort', abort)
      if (finish) startup.finish()
    })
  }
  function action(work, signal, fields = {}, limit = deadlines.start) {
    const startup = budget(signal, limit), intent = { ...fields, controller: startup.controller }
    intents.add(intent)
    const task = mutate(async () => {
      if (startup.signal.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
      return work(startup)
    })
    return waiting(task, startup).finally(() => { intents.delete(intent) })
  }
  async function deleteUnreferenced(name) {
    if (!name || !rt.statePath || typeof rt.deleteSecretIfUnchanged !== 'function' || disposed || rt.readOnly?.() || ctx.fiber?.state === 2 || ctx.root?.fiber?.state === 2
      || !activeMutation || mutationScope.getStore() !== activeMutation) return
    const expected = rt.secretValue(name)
    if (!expected || record().credentialRef === name) return
    try {
      const text = await readFile(rt.statePath, 'utf8')
      if (text.length > 16 * 1024 * 1024) return
      const disk = JSON.parse(text), saved = disk?.prefs?.hermesRemote
      if (!object(disk) || !object(disk.prefs) || !object(saved) || typeof saved.enabled !== 'boolean'
        || (saved.credentialRef !== undefined && typeof saved.credentialRef !== 'string')
        || (saved.credentialRef === undefined && saved.mode !== 'ssh')
        || saved.credentialRef === name || JSON.stringify(saved) !== JSON.stringify(record())
        || text.includes(JSON.stringify(name))) return
      if (disposed || rt.readOnly?.() || record().credentialRef === name || rt.secretValue(name) !== expected) return
      await rt.deleteSecretIfUnchanged(name, expected)
    } catch { /* Missing, unreadable or uncertain durable state keeps the orphan. */ }
  }
  const active = new Set(), leases = new Set(), closing = new Set()
  let registration, adapter, tested, pendingTest, currentLease, pendingConnection, cleanupFailure
  let generation = 0, testGeneration = 0, disposed = false, disconnecting = false

  function budget(signal, limit = deadlines.start) {
    const controller = new AbortController(), until = Date.now() + limit
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    // Whether the deadline itself ended the work, not the person or a newer request.
    let expired = false
    const timer = setTimeout(() => { expired = true; abort() }, limit)
    return { controller, signal: controller.signal, until, expired: () => expired, finish: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
  }
  const remaining = until => ({ ...deadlines, start: Math.max(1, until - Date.now()) })

  const connectionKey = config => JSON.stringify([config.mode ?? 'remote', config.address, config.profile, config.mode === 'ssh' ? config.ssh : undefined, config.extraHomes])
  function requireReplaceable() {
    if (Object.values(state.hermesSessions ?? {}).some(info => info.pendingSubmit || info.uncertain)) throw fail(CHAT_BUSY, 'busy')
  }
  // A record saved by a previous release has no `attached` flag, no profile rows and its
  // old remote-address model list. Once the serve's own profiles are known, rebuild all
  // three and replace an old remote model ref on the paired Bot, so the first open is a
  // Bot Chat join on the profile's own model and never a model override.
  let attachNormalization
  function normalizeAttached(connection) {
    if (connection?.attached !== true) return Promise.resolve()
    const config = record(), profiles = Array.isArray(connection.profiles) ? connection.profiles : []
    const row = profiles.find(profile => profile.id === config.profile)
    // A saved profile the serve no longer offers is a refusal, not a silent move to the
    // first profile: that could join a different Bot's forever-chat.
    if (!row) return Promise.reject(attachProfileRefusal(savedProfileOf(config)))
    const models = [attachedModelOf(row)]
    const bots = Object.values(state.bots ?? {})
    const botsStale = bots.some(bot => ['model', 'appliedModel'].some(key => typeof bot?.[key] === 'string'
      && bot[key].startsWith(`${HERMES_PROVIDER}/`) && bot[key] !== `${HERMES_PROVIDER}/attach`))
    // A record from the previous release carried chats whose old private serve is gone.
    // Their pending/uncertain flags would block the Bot Chat join and every save; the first
    // attached normalization clears that stale state in one step, before the chat opens.
    const migration = config.attached !== true
    const stale = config.mode !== 'ssh' || migration || config.setupVersion !== 1
      || config.profile !== row.id || JSON.stringify(config.profiles ?? []) !== JSON.stringify(profiles)
      || JSON.stringify(config.models ?? []) !== JSON.stringify(models) || !config.credentialRef || botsStale
      // A carried-over connection kept its legacy credential ref: move it to the stable one.
      || config.credentialRef !== ATTACH_CREDENTIAL_REF
    if (!stale) return Promise.resolve()
    return attachNormalization ??= mutate(async () => {
      if (disposed) return
      const current = record()
      if (current !== config) return
      const selected = profiles.find(profile => profile.id === current.profile) ?? row
      // A carried-over connection keeps the credential ref it had before the attach. Its
      // onAuthUpdate has already rewritten that name with the serve's attach token, so the
      // first open does not re-ask; now the token moves to the stable attach ref and the
      // legacy name is removed. The secret first: a refused write leaves no half-moved record.
      const carried = current.credentialRef === undefined || current.credentialRef === ''
        || current.credentialRef === ATTACH_CREDENTIAL_REF ? undefined : current.credentialRef
      if ((!current.credentialRef || carried !== undefined) && connection.credential) {
        await rt.secretEndpoint('secret-set', { name: ATTACH_CREDENTIAL_REF, value: JSON.stringify({ kind: 'attach', credential: connection.credential }), purpose: 'Remote Hermes attached serve token', scope: [] })
        current.credentialRef = ATTACH_CREDENTIAL_REF
      }
      current.mode = 'ssh'; current.attached = true; current.setupVersion = 1; current.profile = selected.id
      current.profiles = profiles
      current.models = [attachedModelOf(selected)]
      if (migration) {
        for (const info of Object.values(state.hermesSessions ?? {})) {
          if (!info || (!info.pendingSubmit && !info.uncertain)) continue
          info.pendingSubmit = false; info.uncertain = false
          delete info.storedSessionId; delete info.runtimeSessionId; delete info.epoch; delete info.lastSeq; delete info.subscriptionId
        }
      }
      // Every Bot on this provider now has one served row. An unpaired Bot's old ref is
      // just as stale as the paired one's, and would keep failing its next turn.
      for (const bot of bots) {
        for (const key of ['model', 'appliedModel']) {
          if (typeof bot?.[key] === 'string' && bot[key].startsWith(`${HERMES_PROVIDER}/`) && bot[key] !== `${HERMES_PROVIDER}/attach`) bot[key] = `${HERMES_PROVIDER}/attach`
        }
      }
      await saveState()
      if (carried !== undefined) await deleteUnreferenced(carried)
      publish()
    }, true).finally(() => { if (attachNormalization) attachNormalization = undefined })
  }
  // Clear pending/uncertain turns only with evidence they belong to an earlier connection:
  // attached chats must differ from the Bot Chat and any known current epoch; other chats
  // must carry a recorded epoch that differs from the serve's known current epoch.
  async function recoverSessions(signal, startup) {
    await rt.load()
    if (disposed) throw fail('The connection is closing.', 'busy')
    if (adapter.live.size) throw fail(CHAT_BUSY, 'busy')
    const owner = generation, config = record(), attached = attachedRecord(config)
    let run, botChatId, currentEpoch
    try {
      if (attached) {
        run = await open({ identity: { canonicalBot: true }, signal, startup })
        await run.prepare()
        botChatId = run.identity?.storedSessionId
      } else run = await open({ signal, startup })
      currentEpoch = run.transport?.epoch
    } finally {
      if (run) await run.close().catch(() => {})
      await drain()
    }
    if (attached && !botChatId) throw fail('The Bot Chat could not be identified; reconcile in Hermes before clearing old turns.', 'pairing')
    if (!attached && typeof currentEpoch !== 'string') throw fail('The current Hermes session could not be identified; reconcile in Hermes before clearing old turns.', 'pairing')
    if (signal.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
    if (disposed || disconnecting || generation !== owner || record() !== config || adapter.live.size || active.size) throw fail(CHAT_BUSY, 'busy')
    let changed = false
    for (const info of Object.values(state.hermesSessions ?? {})) {
      if (!info || (!info.pendingSubmit && !info.uncertain) || !info.storedSessionId) continue
      if (attached) {
        if (info.storedSessionId === botChatId || (typeof currentEpoch === 'string' && info.epoch === currentEpoch)) continue
      } else if (typeof info.epoch !== 'string' || info.epoch === currentEpoch) continue
      info.pendingSubmit = false; info.uncertain = false
      delete info.storedSessionId; delete info.runtimeSessionId; delete info.epoch; delete info.lastSeq; delete info.subscriptionId
      changed = true
    }
    if (changed) { await saveState(); publish() }
    return view()
  }
  function lease(connection, held = false) {
    const entry = { connection, held, users: 0, closed: false }
    entry.close = () => {
      if (entry.task) return entry.task
      entry.closed = true
      if (currentLease === entry) currentLease = undefined
      entry.task = Promise.resolve().then(() => connection.close())
      closing.add(entry.task)
      void entry.task.then(() => { leases.delete(entry); closing.delete(entry.task) }, () => {
        cleanupFailure = fail('The SSH connection could not confirm remote cleanup. Check the remote Hermes before reconnecting.', 'ssh-cleanup')
        closing.delete(entry.task)
      })
      return entry.task
    }
    entry.release = () => {
      entry.users--
      if (!entry.users && !entry.held) void entry.close().catch(() => {})
    }
    leases.add(entry)
    return entry
  }
  async function drain() {
    await Promise.allSettled(closing)
    if (cleanupFailure) throw cleanupFailure
  }
  function savedSecret(config) {
    const value = rt.secretValue(config.credentialRef)
    if (!value) throw fail('Save a credential for Remote Hermes first.', 'auth')
    if (!config.setupVersion) return { kind: 'token', credential: value }
    try {
      const secret = JSON.parse(value)
      if (secret?.kind === 'token' || secret?.kind === 'session' || secret?.kind === 'attach') return secret
    } catch {}
    throw fail('The saved sign-in is unavailable. Set up this connection again.', 'auth')
  }
  function reusableToken(draft) {
    if (draft?.mode !== 'remote' || draft.authMode !== 'token' || (draft.credential !== undefined && draft.credential !== '')) return undefined
    const config = record()
    const key = value => JSON.stringify([value.mode ?? 'remote', value.address, value.authMode ?? 'token', value.credentialRef])
    if (key(draft) !== key(config) || !config.credentialRef) throw fail('Enter the session token for this Hermes.', 'auth')
    const reference = config.credentialRef, value = rt.secretValue(reference), secret = savedSecret(config), owner = generation, expected = key(config)
    if (secret.kind !== 'token') throw fail('Enter the session token for this Hermes.', 'auth')
    // Saving advances our configuration generation. The borrowed credential must
    // remain independently valid across that advance and every awaited save stage.
    const checkCredential = (source = record()) => {
      if (key(source) !== expected || rt.secretValue(reference) !== value) {
        throw fail('The saved connection changed. Connect again before using its token.', 'auth')
      }
    }
    const check = () => {
      if (generation !== owner) throw fail('The saved connection changed. Connect again before using its token.', 'auth')
      checkCredential()
    }
    return { secret, check, checkCredential, reuseReference: config.setupVersion ? reference : undefined }
  }
  async function acquire(config, signal, until) {
    if (!config.setupVersion) return undefined // Preserve the installed legacy transport contract.
    if (currentLease && !currentLease.closed) return currentLease
    if (!pendingConnection) {
      const owner = generation, controller = new AbortController()
      const secret = config.mode === 'ssh'
        ? (config.attached === true && config.credentialRef ? savedSecret(config) : undefined)
        : savedSecret(config)
      const pending = { controller, waiters: 0 }
      pendingConnection = pending
      pending.task = prepareHermesConnection({ mode: config.mode, address: config.address, authMode: config.authMode, ssh: config.ssh, extraHomes: config.extraHomes }, {
        fetch: fetcher, startSsh, signal: controller.signal, deadlines: remaining(until), secret, discover: false,
        onAuthUpdate: updated => mutate(async () => {
          if (!config.credentialRef) return
          if (disposed || owner !== generation || record().credentialRef !== config.credentialRef) throw fail('Connection setup was cancelled.')
          await rt.secretEndpoint('secret-set', {
            name: config.credentialRef, value: JSON.stringify(updated), scope: [],
            purpose: updated.kind === 'attach' ? 'Remote Hermes attached serve token' : 'Remote Hermes authenticated connection',
          })
        }, true),
      }).then(async connection => {
        if (disposed || disconnecting || owner !== generation || controller.signal.aborted) {
          await connection.close()
          throw fail('This connection setup was cancelled.')
        }
        return pending.owned = currentLease = lease(connection)
      }).finally(() => { if (pendingConnection === pending) pendingConnection = undefined })
      void pending.task.catch(() => {})
    }
    const pending = pendingConnection
    pending.waiters++
    let abort
    try {
      if (!signal) return await pending.task
      if (signal.aborted) throw fail('Connection setup was cancelled.')
      return await Promise.race([pending.task, new Promise((_, reject) => {
        abort = () => reject(fail('Connection setup was cancelled.'))
        signal.addEventListener('abort', abort, { once: true })
      })])
    } finally {
      signal?.removeEventListener('abort', abort)
      pending.waiters--
      if (!pending.waiters && signal?.aborted) {
        pending.controller.abort()
        if (pending.owned && !pending.owned.users) await pending.owned.close()
      }
    }
  }
  async function open(options = {}) {
    const startup = options.startup ?? budget(options.signal)
    const ownsStartup = !options.startup || options.finishOnPrepare === true
    const started = Date.now()
    try {
      await rt.load(); await rt.loadSecrets()
      const config = record(), owner = generation
      if (disposed || disconnecting || !config.enabled) throw refusal('Turn on Remote Hermes in Bot settings first.')
      const owned = options.connectionLease ?? await acquire(config, startup.signal, startup.until)
      if (disposed || disconnecting || owner !== generation || options.signal?.aborted || owned?.closed) {
        if (owned && !owned.users) await owned.close()
        throw fail('Connection setup was cancelled.')
      }
      const connection = owned?.connection
      if (connection?.attached === true) {
        try { await normalizeAttached(connection) }
        catch (error) {
          if (owned && !owned.users) await owned.close().catch(() => {})
          throw error
        }
      }
      const credential = connection?.credential ?? savedSecret(config).credential
      if (owned) owned.users++
      let wire
      try {
        wire = transport(connection ? {
          address: connection.address, profile: options.profile ?? config.profile, credential, authHeaders: connection.authHeaders,
          attached: connection.attached === true,
          allowLoopback: connection.allowLoopback, redactionSecrets: connection.redactionSecrets,
          deadlines: remaining(startup.until),
          fetch: async (...args) => {
            const response = await connection.fetch(...args)
            for (const secret of connection.redactionSecrets) wire?.secrets?.add(secret)
            return response
          },
        } : { address: config.address, profile: config.profile, credential, deadlines: remaining(startup.until) })
      } catch (error) { owned?.release(); throw error }
      active.add(wire)
      let closed = false
      const close = wire.close.bind(wire), abort = () => wire.close()
      wire.close = () => {
        if (closed) return
        closed = true
        options.signal?.removeEventListener('abort', abort)
        startup.signal.removeEventListener('abort', abort)
        active.delete(wire)
        close()
        owned?.release()
        if (ownsStartup) startup.finish()
      }
      startup.signal.addEventListener('abort', abort, { once: true })
      try {
        await wire.connect()
        if (startup.signal.aborted) throw fail('Connection setup was cancelled or timed out.')
        const run = new RemoteChat(wire, options)
        const submit = run.submit.bind(run)
        run.submit = (...args) => action(async admission => {
          // Admit the turn on the same owner that replaces its connection. A
          // prepared old run cannot submit after replacement/teardown has begun.
          if (disposed || disconnecting || owner !== generation || record() !== config || admission.signal.aborted
            || (options.identity && !Object.values(state.hermesSessions ?? {}).includes(options.identity))) throw fail(CHAT_BUSY, 'busy')
          const stop = () => { void run.stop().catch(() => {}) }
          admission.signal.addEventListener('abort', stop, { once: true })
          try { return await submit(...args) }
          finally { admission.signal.removeEventListener('abort', stop) }
        }, options.signal, {}, Math.max(1, startup.until - Date.now()))
        if (ownsStartup) {
          const prepare = run.prepare.bind(run)
          run.prepare = async (...args) => {
            try { return await prepare(...args) }
            finally { startup.finish(); startup.signal.removeEventListener('abort', abort) }
          }
        }
        return run
      } catch (error) {
        wire.close()
        throw connectionFailure(error, true)
      }
    } catch (error) {
      if (ownsStartup) startup.finish()
      if (record().mode === 'ssh' && record().enabled && !startup.signal.aborted && !options.signal?.aborted) noteSshFailure('connect', record().ssh, error, started)
      throw error?.code === 'bot/refused' && error.cleanupUnknown !== true ? error : connectionFailure(error)
    }
  }
  // The rows the model menu and listModels may see: an attached connection exposes only
  // its selected profile's own row. Before the first connect an old SSH record exposes
  // none, never the retired remote-address model list.
  const servedModels = () => {
    const config = record()
    if (!attachedRecord(config)) return config.models ?? []
    const row = attachedModelFor(config)
    return row ? [row] : []
  }
  // The model the connected view names: the one a Bot on this connection already saved,
  // when the connection serves it. The first served model seeds a Bot that has none yet
  // (first setup), never a Bot that already picked one.
  const currentModelRef = () => {
    if (attachedRecord(record())) {
      const row = attachedModelFor(record())
      return row ? `${HERMES_PROVIDER}/${row.id}` : undefined
    }
    const models = record().models ?? []
    const served = new Set(models.map(model => `${HERMES_PROVIDER}/${model.id}`))
    const bots = Object.values(state.bots ?? {})
    const paired = record().pairedBotId ? state.bots?.[record().pairedBotId] : undefined
    const candidates = paired === undefined ? bots : [paired, ...bots.filter(bot => bot !== paired)]
    for (const bot of candidates) {
      const ref = [bot?.model, bot?.appliedModel].find(ref => typeof ref === 'string' && served.has(ref))
      if (ref !== undefined) return ref
    }
    return models[0] ? `${HERMES_PROVIDER}/${models[0].id}` : undefined
  }
  const view = () => {
    const config = record(), attached = attachedRecord(config)
    // An attached connection has exactly one model row: the selected profile's own. Old
    // saved remote-address model lists are never shown as the attached bot's model.
    const row = attached ? attachedModelFor(config) : undefined
    const profile = attached && Array.isArray(config.profiles) ? config.profiles.find(item => item.id === config.profile) : undefined
    return {
      enabled: enabled(), mode: config.mode ?? 'remote', authMode: config.authMode ?? 'token',
      address: config.address ?? '', profile: config.profile ?? '', profileName: profile?.name ?? '',
      ssh: config.mode === 'ssh' ? sshFields(config.ssh) : undefined,
      extraHomes: extraHomes(config.extraHomes),
      pairedBotId: config.pairedBotId ?? '',
      bots: Object.values(state.bots ?? {}).map(bot => ({ id: bot.id, name: bot.name })),
      credentialRef: config.credentialRef ?? '', credentialSet: config.mode === 'ssh' ? Boolean(config.enabled) : Boolean(rt.secretValue?.(config.credentialRef)),
      models: attached ? (row ? [row] : []) : config.models ?? [], attached, model: row,
      limitations: MISSING_TOOLS, minimum: HERMES_MINIMUM,
      modelRef: currentModelRef(),
      sessions: Object.entries(state.hermesSessions ?? {}).map(([sessionId, info]) => ({ sessionId, ...info })),
    }
  }
  const publish = ({ startup = false } = {}) => {
    if (disposed) return
    adapter.registerAll()
    // Keep the provider registered for an attached connection even before its first
    // connect: the model menu then lists no row (never the retired list), while an old
    // chat can still open and let the first attach normalization fill the one real row.
    const shouldRegister = enabled() && (attachedRecord(record()) || servedModels().length > 0)
    // When startup leaves the adapter list alone, a desktop catalog already building
    // can still publish.
    if (startup && registration === undefined && !shouldRegister) return
    registration?.(); registration = undefined
    if (shouldRegister) registration = ctx.llm.registerAdapter([HERMES_PROVIDER], adapter)
    rt.dropCatalog?.()
  }
  async function stopLive() {
    pendingConnection?.controller.abort()
    await Promise.allSettled([...adapter.live.values()].map(entry => entry.run.stop()))
    adapter.dispose()
    for (const wire of active) wire.close()
    active.clear()
    if (pendingConnection) await Promise.allSettled([pendingConnection.task])
    for (const owned of leases) if (owned !== tested?.lease) await owned.close().catch(() => {})
    await drain()
  }
  async function cancelTests({ testId, requestId } = {}) {
    const scoped = testId !== undefined || requestId !== undefined
    if ((testId !== undefined && (typeof testId !== 'string' || !testId))
      || (requestId !== undefined && (typeof requestId !== 'string' || !requestId))) return
    const matches = entry => entry && (testId === undefined || entry.id === testId)
      && (requestId === undefined || entry.requestId === requestId)
    const pending = matches(pendingTest) ? pendingTest : undefined
    const previous = matches(tested) ? tested : undefined
    if (scoped && !pending && !previous) return
    if (!scoped || pending) testGeneration++
    if (pending) pendingTest = undefined
    if (previous) tested = undefined
    pending?.controller.abort()
    previous?.controller.abort()
    clearTimeout(previous?.timer)
    if (previous) await previous.lease.close()
    if (pending) await Promise.allSettled([pending.task])
  }
  async function testDraft(draft, signal, startup = budget(signal)) {
    if (disposed) throw fail('Connection setup is no longer available.')
    const cancelling = cancelTests(), owner = testGeneration, started = Date.now()
    const controller = startup.controller
    const pending = { controller, requestId: typeof draft?.requestId === 'string' && draft.requestId.length <= 100 ? draft.requestId : undefined, stage: 'reach' }
    pendingTest = pending
    pending.task = (async () => {
      await cancelling
      if (owner !== testGeneration || controller.signal.aborted) throw fail('Connection setup was cancelled.')
      await rt.load(); await rt.loadSecrets()
      if (owner !== testGeneration || controller.signal.aborted) throw fail('Connection setup was cancelled.')
      const source = reusableToken(draft)
      const checkedFetch = source ? async (...args) => {
        source.check()
        const response = await fetcher(...args)
        source.check()
        return response
      } : fetcher
      const connection = await prepareHermesConnection(draft, { fetch: checkedFetch, startSsh, signal: controller.signal, deadlines: remaining(startup.until), secret: source?.secret,
        onProgress: stage => { if (pendingTest === pending && owner === testGeneration && !controller.signal.aborted) pending.stage = stage },
      })
      if (disposed || owner !== testGeneration || controller.signal.aborted) { await connection.close(); throw fail('Connection setup was cancelled.') }
      const entry = { id: randomUUID(), lease: lease(connection, true), controller, expires: now() + testLifetime, requestId: pending.requestId, checkSource: source?.check, checkSavedSource: source?.checkCredential, reuseReference: source?.reuseReference, fetch: checkedFetch }
      try {
        entry.checkSource?.()
        const chosen = draft?.profile === undefined ? connection.profiles[0].id
          : connection.profiles.find(profile => profile.id === draft.profile)?.id
        if (!chosen) throw fail('The chosen bot is not served by this Hermes any more. Check the bots again.', 'profiles')
        await probe(entry.lease, chosen, controller.signal, startup.until)
        entry.checkSource?.()
        if (disposed || owner !== testGeneration || controller.signal.aborted) throw fail('Connection setup was cancelled.')
      } catch (error) { if (error && typeof error === 'object') error.hermesStage ??= 'chat'; await entry.lease.close(); throw error }
      // Keep only connection references and ephemeral session material, never the submitted password/user.
      entry.config = {
        mode: connection.mode, authMode: connection.authMode, address: connection.mode === 'remote' ? connection.address : '',
        ...(connection.mode === 'ssh' ? { ssh: sshFields(connection.ssh) } : {}),
        ...(extraHomes(draft.extraHomes).length ? { extraHomes: extraHomes(draft.extraHomes) } : {}),
        ...(connection.attached === true ? { attached: true, profiles: connection.profiles } : {}),
      }
      entry.timer = setTimeout(() => { entry.controller.abort(); void mutate(async () => { if (tested === entry) { tested = undefined; await entry.lease.close() } }).catch(() => {}) }, testLifetime)
      entry.timer.unref?.()
      tested = entry
      pending.stage = 'connected'
      return { testId: entry.id, profiles: connection.profiles,
        defaultProfile: draft?.profile === undefined ? (connection.defaultProfile ?? connection.profiles[0].id) : draft.profile,
        status: 'connected' }
    })()
    try {
      const answer = await pending.task
      if (pending.requestId) failures.delete(pending.requestId)
      return answer
    } catch (error) {
      // A test the person replaced or closed is not a failure to report.
      const shown = error?.cleanupUnknown === true ? connectionFailure(error) : error
      // The start deadline ended this test: SSH only saw its own cancel, and the wizard
      // shows a timeout. The record says the same, with the stage SSH had reached.
      const noted = error?.cleanupUnknown === true ? Object.assign(shown, { sshStage: error.sshStage, sshDetail: error.sshDetail, sshError: 'cleanup' })
        : startup.expired?.() && error?.sshError === 'unknown' ? Object.assign(new Error(CONNECTION_ERRORS['bot/hermes-ssh-timeout']), { code: 'bot/hermes-ssh-timeout', sshError: 'timeout', sshStage: error.sshStage, sshDetail: error.sshDetail })
        : error
      if (draft?.mode === 'ssh' && owner === testGeneration && !disposed) noteSshFailure(pending.requestId, draft.ssh, noted, started, error)
      throw shown
    } finally {
      startup.finish()
      if (pendingTest === pending) pendingTest = undefined
    }
  }
  // Trust the one new host key the failed test showed: the host kept its type and
  // fingerprint, so the browser names only its own request, never a key.
  async function trustHostKey(body, signal) {
    const key = typeof body?.requestId === 'string' ? body.requestId : undefined
    const entry = failureOf(key)
    if (disposed || !entry || entry.view.kind !== 'host-key-unknown' || !entry.view.keyType || !entry.view.fingerprint || entry.view.unsaved) {
      throw fail('Connect again before trusting this host.', 'expired')
    }
    const started = Date.now()
    failures.delete(key)
    try {
      const answer = await trustSsh(entry.ssh, { keyType: entry.view.keyType, fingerprint: entry.view.fingerprint }, { signal, deadlines })
      return { trusted: answer?.trusted === true }
    } catch (error) {
      noteSshFailure(key, entry.ssh, error, started)
      throw Object.hasOwn(CONNECTION_ERRORS, error?.code) ? refusal(CONNECTION_ERRORS[error.code], { code: error.code }) : fail('This host key could not be trusted. Connect again.', 'ssh')
    }
  }
  async function probe(owned, profile, signal, until) {
    // Probe a chosen profile without enabling the adapter or sending a message. An
    // attached serve is probed by joining its Bot Chat, never by asking for a model list.
    const attached = owned.connection.attached === true
    const wire = transport({ address: owned.connection.address, profile, credential: owned.connection.credential,
      attached,
      authHeaders: owned.connection.authHeaders, allowLoopback: owned.connection.allowLoopback, redactionSecrets: owned.connection.redactionSecrets,
      deadlines: remaining(until), fetch: async (...args) => {
        const response = await owned.connection.fetch(...args)
        for (const secret of owned.connection.redactionSecrets) wire.secrets?.add(secret)
        return response
      } })
    owned.users++
    let closed = false
    const close = wire.close.bind(wire), abort = () => wire.close()
    wire.close = () => { if (closed) return; closed = true; signal?.removeEventListener('abort', abort); close(); owned.release() }
    signal?.addEventListener('abort', abort, { once: true })
    let run
    try {
      if (signal?.aborted) throw fail('Connection setup was cancelled.')
      await wire.connect()
      if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.')
      // The test joins the profile's one Bot Chat; it never creates a conversation.
      run = new RemoteChat(wire, { identity: attached ? { canonicalBot: true } : {} })
      await run.prepare()
      if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.')
      if (attached) {
        const row = owned.connection.profiles.find(item => item.id === profile) ?? owned.connection.profiles[0]
        return row ? [attachedModelOf(row)] : []
      }
      const models = await wire.models()
      if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.')
      if (!models.length) throw fail('This profile has no available models. Configure a model in Hermes and try again.', 'profiles')
      return models
    } finally {
      signal?.removeEventListener('abort', abort)
      // An attached viewer detaches; an app-owned probe session closes. Neither path
      // stops the remote Hermes.
      if (run && attached) await run.close().catch(() => {})
      else if (run) {
        if (run.identity.runtimeSessionId) await wire.request('session.close', { session_id: run.identity.runtimeSessionId }).catch(() => {})
        run.dispose()
      } else wire.close()
    }
  }
  async function saveTest(body, signal, startup = budget(signal)) {
    try { return await saveTestWithin(body, startup) }
    catch (error) { throw error?.cleanupUnknown === true ? connectionFailure(error) : error }
    finally { startup.finish() }
  }
  async function saveTestWithin(body, startup) {
    await rt.load(); await rt.loadSecrets()
    const entry = tested
    if (!entry || entry.id !== body?.testId || entry.expires <= now() || entry.lease.closed) throw fail('This connection waited too long and was closed. Connect again.', 'expired')
    const signal = AbortSignal.any([startup.signal, entry.controller.signal])
    if (signal.aborted) throw fail('Connection setup was cancelled.')
    entry.checkSource?.()
    const chosen = entry.lease.connection.profiles.find(profile => profile.id === body.profile)
    const profile = chosen?.id
    if (!profile) throw fail('Choose a profile returned by this Hermes.', 'profiles')
    const next = { ...entry.config, profile, setupVersion: 1, enabled: true }
    if (record().pairedBotId) {
      if (connectionKey(next) !== connectionKey(record())) throw fail('Disconnect the paired Bot before changing its Hermes connection or profile.', 'pairing')
      next.pairedBotId = record().pairedBotId
    }
    requireReplaceable()
    const models = await probe(entry.lease, profile, signal, startup.until)
    entry.checkSource?.()
    if (tested !== entry || disposed || signal?.aborted || entry.expires <= now()) throw fail('This connection waited too long or was cancelled. Connect again.', 'expired')
    const old = record(), oldSessions = state.hermesSessions
    const changed = connectionKey(next) !== connectionKey(old)
    entry.lease.held = false
    await entry.lease.close()
    if (tested !== entry || disposed || signal?.aborted) throw fail('Connection setup was cancelled.')
    entry.checkSource?.()
    const attached = entry.lease.connection.attached === true
    const name = entry.reuseReference ?? (entry.lease.connection.secret ? (attached ? ATTACH_CREDENTIAL_REF : `HERMES_REMOTE_${randomUUID().replaceAll('-', '').toUpperCase()}`) : undefined)
    const writesSecret = Boolean(name && !entry.reuseReference)
    let installed, installedSessions, saveGeneration
    try {
      if (tested !== entry || disposed || signal?.aborted) throw fail('Connection setup was cancelled.')
      entry.checkSource?.()
      disconnecting = true; saveGeneration = ++generation
      await stopLive()
      if (tested !== entry || disposed || signal?.aborted || generation !== saveGeneration) throw fail('Connection setup was cancelled.')
      entry.checkSavedSource?.()
      requireReplaceable()
      if (writesSecret) await rt.secretEndpoint('secret-set', {
        name, value: JSON.stringify(entry.lease.connection.secret), scope: [],
        purpose: attached ? 'Remote Hermes attached serve token' : 'Remote Hermes authenticated connection',
      })
      if (tested !== entry || disposed || signal?.aborted || generation !== saveGeneration) throw fail('Connection setup was cancelled.')
      entry.checkSavedSource?.()
      state.prefs ??= {}
      installed = { ...next, models, ...(attached ? { attached: true, profiles: entry.lease.connection.profiles } : {}), ...(name ? { credentialRef: name } : {}) }
      state.prefs.hermesRemote = installed
      if (changed) state.hermesSessions = installedSessions = {}
      await saveState()
      if (tested !== entry || disposed || signal?.aborted || record() !== installed || generation !== saveGeneration) throw fail('The saved connection changed. Connect again before saving.')
      entry.checkSavedSource?.(old)
    } catch (error) {
      // Roll back only our own installed state. An awaited write may have let a
      // different configuration finish before this stale save rejects.
      let rollbackError
      if (installed && record() === installed && generation === saveGeneration) {
        state.prefs.hermesRemote = old
        if (installedSessions && state.hermesSessions === installedSessions) state.hermesSessions = oldSessions
        try { await saveState() }
        catch { rollbackError = fail('The saved connection could not be restored on disk. Check its settings before connecting again.') }
      }
      // A failed durable rollback may still reference our new secret on disk.
      if (writesSecret && !rollbackError) await deleteUnreferenced(name)
      throw rollbackError ?? error
    } finally { if (generation === saveGeneration) disconnecting = false }
    tested = undefined; clearTimeout(entry.timer)
    // Reused token sources are never rewritten or deleted. Legacy raw tokens
    // need a descriptor copy, but retaining their source avoids a delete race.
    if (!entry.checkSavedSource && old.credentialRef !== name) await deleteUnreferenced(old.credentialRef)
    publish()
    return view()
  }
  async function configure(body, signal) {
    await rt.load(); await rt.loadSecrets()
    if (record().pairedBotId) throw fail('Disconnect the paired Bot before replacing its Hermes configuration.', 'pairing')
    if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
    if (typeof body.enabled !== 'boolean') throw refusal('Choose whether Remote Hermes is on.')
    const address = body.address ? remoteAddress(body.address) : record().address
    const profile = typeof body.profile === 'string' ? body.profile.trim() : record().profile ?? ''
    if (profile.length > 100 || ['\r', '\n', '\0'].some(character => profile.includes(character))) throw refusal('Enter a valid Hermes profile name.')
    if (body.enabled && !address) throw refusal('Enter the Hermes address before turning it on.')
    const next = { enabled: body.enabled, address, profile, credentialRef: CREDENTIAL_REF }
    requireReplaceable()
    const changed = connectionKey(next) !== connectionKey(record())
    const credential = body.credential !== undefined && body.credential !== '' ? body.credential : undefined
    if (body.enabled && !credential && !rt.secretValue(CREDENTIAL_REF)) throw refusal('Save a credential before turning Remote Hermes on.')
    if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
    await cancelTests()
    disconnecting = true; generation++
    try {
      await stopLive()
      if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
      requireReplaceable()
      if (credential !== undefined) await rt.secretEndpoint('secret-set', { name: CREDENTIAL_REF, value: credential, purpose: 'Remote Hermes connection credential', scope: [] })
      if (signal?.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
      state.prefs ??= {}
      state.prefs.hermesRemote = { ...next, models: changed ? [] : record().models ?? [] }
      if (changed) state.hermesSessions = {}
      await saveState()
    } finally { disconnecting = false }
    publish()
    return view()
  }
  async function discover(signal, startup = budget(signal)) {
    let run, attached = false
    try {
      attached = attachedRecord(record())
      run = await open({ signal: startup.signal, startup, ...(attached ? { identity: { canonicalBot: true } } : {}) })
      await run.prepare()
      if (attached) {
        const row = attachedModelFor(record())
        record().models = row ? [row] : []
      } else record().models = await run.transport.models()
      await saveState(); publish()
      return view()
    } finally {
      if (run && attached) await run.close().catch(() => {})
      else if (run) {
        if (run.identity.runtimeSessionId) await run.transport.request('session.close', { session_id: run.identity.runtimeSessionId }).catch(() => {})
        run.dispose()
      }
      startup.finish()
      await drain()
    }
  }
  async function connect(body, signal, startup) {
    await rt.load(); await rt.loadSecrets()
    if (!enabled()) throw fail('Set up Remote Hermes before connecting.')
    // Opening a configured connection shows the models it already saved: a throwaway
    // session just to list them again is not opened. An attached connection is only
    // current once its single row and its profile rows are saved; an old SSH record is
    // normalized by discover, never trusted from its old remote-address model list.
    if (body?.cached === true) {
      if (attachedRecord(record()) ? attachedModelsCurrent(record()) : (record().models?.length ?? 0) > 0) return view()
    }
    return discover(signal, startup)
  }
  async function savePair(botId, signal) {
    const previous = record(), owner = generation
    if (signal?.aborted || disposed) throw fail('Pairing was cancelled.', 'pairing')
    const installed = { ...previous, pairedBotId: botId || undefined }
    state.prefs.hermesRemote = installed
    try {
      await saveState()
      if (signal?.aborted || disposed || generation !== owner || record() !== installed) throw fail('Pairing was cancelled or changed.', 'pairing')
    } catch (error) {
      if (record() === installed && generation === owner) {
        state.prefs.hermesRemote = previous
        await saveState()
      }
      throw error
    }
    generation++
    publish()
    return view()
  }
  async function pairBot(body, signal) {
    await rt.load(); await rt.loadSecrets()
    if (!enabled() || !record().profile) throw fail('Connect a Hermes profile before pairing.', 'pairing')
    const botId = body?.botId
    if (botId === '') {
      requireReplaceable()
      if (adapter.live.size) throw fail(CHAT_BUSY, 'busy')
      return savePair('', signal)
    }
    if (typeof botId !== 'string' || !Object.hasOwn(state.bots ?? {}, botId)) throw fail('Choose an existing Automagik Bot.', 'pairing')
    // Remote Hermes runs its own tools on the other computer, outside this plugin's guard.
    if (state.bots[botId].shell === false) throw fail(CONNECTION_ERRORS['bot/hermes-shell'], 'shell')
    if (!state.bots[botId].model?.startsWith(`${HERMES_PROVIDER}/`)) throw fail('Choose Remote Hermes in this Bot’s chat before pairing it.', 'pairing')
    if (record().pairedBotId && record().pairedBotId !== botId) throw fail('This Hermes profile is already paired. Unpair it before choosing another Bot.', 'pairing')
    requireReplaceable()
    if (adapter.live.size) throw fail(CHAT_BUSY, 'busy')
    const run = await open({ identity: { canonicalBot: true }, signal })
    try {
      await run.prepare()
      requireReplaceable()
      if (signal?.aborted) throw fail('Pairing was cancelled.', 'pairing')
      return await savePair(botId, signal)
    } finally { await run.close().catch(() => {}); await drain() }
  }
  async function disconnect(body = {}) {
    await cancelTests(body?.testsOnly ? { testId: body.testId, requestId: body.requestId } : undefined)
    if (body?.testsOnly) return view()
    disconnecting = true; generation++
    try { await stopLive() } finally { disconnecting = false }
    return view()
  }
  // Detection is one read-only SSH command: it finds the homes, serves and profiles and
  // returns them; nothing is tested, saved or started here.
  async function detectBots(body, signal, startup) {
    const ssh = body?.ssh
    if (!object(ssh)) throw fail('Enter an SSH host or config name.', 'ssh')
    const started = Date.now()
    try {
      hermesSshDestination(ssh)
      const found = await detectHermes(sshFields(ssh), { signal, deadlines: remaining(startup.until), extraHomes: extraHomes(body.extraHomes) })
      return { homes: found.homes, bots: found.bots }
    } catch (error) {
      if (typeof body?.requestId === 'string' && body.requestId) noteSshFailure(body.requestId, ssh, error, started)
      throw error
    }
  }
  async function refreshProfiles(body, signal, startup) {
    const entry = tested
    if (!entry || entry.id !== body?.testId || entry.expires <= now() || entry.lease.closed) throw fail('This connection waited too long and was closed. Connect again.', 'expired')
    entry.checkSource?.()
    const combined = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal
    const profiles = await refreshHermesProfiles(entry.lease.connection, { fetch: entry.fetch, startSsh, signal: combined, deadlines: startup ? remaining(startup.until) : deadlines })
    entry.checkSource?.()
    if (tested !== entry || entry.expires <= now() || combined.aborted) throw fail('This connection waited too long or was cancelled. Connect again.', 'expired')
    entry.lease.connection.profiles = profiles
    return { profiles }
  }

  const api = {
    view,
    test: (draft, signal) => {
      interruptTests()
      return action(startup => testDraft(draft, startup.signal, startup), signal, { test: true, requestId: draft?.requestId })
    },
    save: (body, signal) => action(startup => saveTest(body, startup.signal, startup), signal, { test: true, testId: body?.testId, requestId: tested?.id === body?.testId ? tested.requestId : undefined }),
    configure: (body, signal) => {
      interruptTests()
      return action(startup => configure(body, startup.signal), signal, {}, deadlines.control)
    },
    discover: signal => action(startup => discover(startup.signal, startup), signal),
    connect: (body, signal) => action(startup => connect(body, startup.signal, startup), signal),
    refreshProfiles: (body, signal) => action(startup => refreshProfiles(body, startup.signal, startup), signal, { test: true, testId: body?.testId }),
    disconnect: body => {
      const filter = body?.testsOnly ? body : {}
      const matched = interruptTests(filter)
      if (body?.testsOnly && !matched) return Promise.resolve(view())
      if (!body?.testsOnly) {
        for (const intent of intents) intent.controller.abort()
        pendingConnection?.controller.abort()
      }
      const startup = budget(undefined, deadlines.cancel)
      return waiting(mutate(() => disconnect(body)), startup)
    },
  }
  const openChat = options => {
    const startup = budget(options?.signal)
    const expectedGeneration = generation, expectedConfig = record(), changing = disconnecting
    const expectedIdentity = options?.identity
    const task = mutate(async () => {
      if (startup.signal.aborted) throw fail('Connection setup was cancelled or timed out.', 'timeout')
      if (disposed || changing || expectedGeneration !== generation || expectedConfig !== record()
        || (expectedIdentity && !Object.values(state.hermesSessions ?? {}).includes(expectedIdentity))) throw fail(CHAT_BUSY, 'busy')
      return open({ ...options, startup, finishOnPrepare: true })
    })
    return waiting(task, startup, false).catch(error => {
      startup.finish()
      const config = record()
      if (config?.mode === 'ssh') {
        const line = startLine(config)
        if (error?.code === 'bot/hermes-attach-not-running' || error?.code === 'bot/hermes-attach-record') throw refusal(`Hermes is not running on the other computer. Start it there with “${line}”, then try again.`, { code: 'bot/hermes' })
        if (error?.code === 'bot/hermes-attach-gateway-running') throw refusal(`Hermes is running on the other computer as a gateway, but no “hermes serve” is running. Start “${line}” there, then try again.`, { code: 'bot/hermes' })
        if (error?.code === 'bot/hermes-attach-gateway') throw refusal(`Hermes is running there as a gateway that owns its sessions. Start “${line}” there, then try again.`, { code: 'bot/hermes' })
      }
      throw error
    })
  }
  adapter = new RemoteChatAdapter(rt, { open: openChat, models: servedModels, identity, save: saveState, enabled, attached: () => attachedRecord(record()) })
  api.adapter = adapter
  rt.hooks.endpoint('hermes-remote', async () => { await rt.load(); await rt.loadSecrets(); return view() }, { read: true })
  rt.hooks.endpoint('hermes-remote-recover', (_body, signal) => action(startup => recoverSessions(startup.signal, startup), signal))
  rt.hooks.endpoint('hermes-remote-ssh-hosts', async (_body, signal) => {
    try {
      const found = await sshHosts({ signal })
      const project = rows => Array.isArray(rows) ? rows.flatMap(row => {
        if (!row || typeof row.alias !== 'string' || !row.alias) return []
        return [Object.fromEntries(['alias', 'hostname', 'user', 'port'].map(key => [key, typeof row[key] === 'string' ? row[key] : '']))]
      }) : []
      return { aliases: project(found?.aliases), knownHosts: project(found?.knownHosts) }
    } catch { return { aliases: [], knownHosts: [] } }
  }, { read: true })
  rt.hooks.endpoint('hermes-remote-detect', (body, signal) => action(startup => detectBots(body, startup.signal, startup), signal, {}))
  rt.hooks.endpoint('hermes-remote-test', (body, signal) => api.test(body, signal))
  rt.hooks.endpoint('hermes-remote-test-status', body => {
    const failure = failureOf(body?.connect === true ? 'connect' : body?.requestId)?.view
    return { stage: pendingTest?.requestId && pendingTest.requestId === body?.requestId
      ? pendingTest.stage : tested?.requestId && tested.requestId === body?.requestId ? 'connected' : 'reach', ...(failure ? { failure } : {}) }
  }, { read: true })
  rt.hooks.endpoint('hermes-remote-ssh-trust', (body, signal) => trustHostKey(body, signal))
  rt.hooks.endpoint('hermes-remote-test-profiles', (body, signal) => api.refreshProfiles(body, signal))
  rt.hooks.endpoint('hermes-remote-save', (body, signal) => api.save(body, signal))
  rt.hooks.endpoint('hermes-remote-connect', (body, signal) => api.connect(body, signal))
  rt.hooks.endpoint('hermes-remote-pair', (body, signal) => action(startup => pairBot(body, startup.signal), signal))
  rt.hooks.endpoint('hermes-remote-disconnect', api.disconnect)
  rt.hooks.endpoint('hermes-remote-configure', api.configure)
  rt.hooks.endpoint('hermes-remote-discover', (_body, signal) => api.discover(signal))
  rt.hooks.endpoint('hermes-remote-reconcile', (body, signal) => action(async startup => {
    signal = startup.signal
    const info = sessions()[body.sessionId]
    if (!info?.storedSessionId) throw refusal('There is no saved remote session to reconcile.')
    const run = await open({ identity: info, save: saveState, signal, startup })
    try {
      const result = await run.reconcile()
      return { ...view(), reconciliation: { unknown: result.unknown, gap: result.gap, messages: result.snapshot.messages, inflight: result.snapshot.inflight } }
    } finally { await run.close().catch(() => {}); await drain() }
  }, signal))
  ctx.effect(() => {
    void rt.load().then(() => mutate(() => publish({ startup: true }))).catch(() => {})
    return async () => {
      interruptTests()
      for (const intent of intents) intent.controller.abort()
      pendingConnection?.controller.abort()
      await mutate(async () => {
        disposed = true
        registration?.(); registration = undefined
        await disconnect()
      })
    }
  }, 'ds-bot: remote Hermes')
  Object.assign(rt, { hermesRemote: api })
}
