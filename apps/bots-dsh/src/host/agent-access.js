// Space reads and administration over stateless MCP Streamable HTTP. No browser cookies.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import ipaddr from 'ipaddr.js'
import { createServer } from 'node:http'
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'
import { createAgentRedactor } from './agent-redaction.js'
import { multiuserMode } from './multiuser.js'

export const MCP_PATH = '/api/omni-mcp'
const VERSION = '2025-11-25'
const VERSIONS = new Set([VERSION, '2025-03-26', '2025-06-18'])
const LIMIT = 65536
const BOT_FIELDS = ['id', 'name', 'role', 'color', 'instructions', 'model', 'effort', 'permission']
const ROOM_FIELDS = ['id', 'name', 'notice', 'members', 'admin', 'permission', 'mode']
const pick = (value, fields) => value == null ? null
  : Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
export const botConfig = (bot, mainBotIds = []) => bot == null ? null
  : { ...pick(bot, BOT_FIELDS), main: mainBotIds.includes(bot.id) }
export const roomConfig = room => pick(room, ROOM_FIELDS)
const string = { type: 'string', maxLength: 16000 }
const nullable = { anyOf: [string, { type: 'null' }] }
const pageProps = { offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100 } }
const members = { type: 'array', items: string, maxItems: 100 }
const botProps = Object.fromEntries(BOT_FIELDS.filter(key => key !== 'id').map(key => [key,
  ['model', 'effort'].includes(key) ? nullable : string]))
const roomProps = { name: string, notice: string, members, admin: string, permission: string }
const tool = (name, endpoint, description, properties = {}, required = []) => ({
  name, endpoint, description, read: endpoint.startsWith('space-'),
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
})
export const AGENT_TOOLS = [
  tool('list_bots', 'space-bots', 'Page Bot configuration, folders and status.', pageProps),
  tool('get_bot', 'space-bot', 'Get Bot configuration.', { id: string }, ['id']),
  tool('create_bot', 'create-bot', 'Create a Bot.',
    Object.fromEntries(Object.entries(botProps).filter(([key]) => key !== 'permission')), ['name']),
  tool('update_bot', 'update-bot', 'Edit instructions, model, effort or permissions.',
    { id: string, ...botProps }, ['id']),
  tool('delete_bot', 'delete-bot', 'Delete a Bot.', { id: string }, ['id']),
  tool('set_main', 'set-main', 'Set or remove the Main Bot role.',
    { id: string, main: { type: 'boolean' }, primary: { type: 'boolean' }, replace: string },
    ['id']),
  tool('list_groups', 'space-groups', 'Page groups and membership.', pageProps),
  tool('get_group', 'space-group', 'Get group configuration.', { id: string }, ['id']),
  tool('create_group', 'create-room', 'Create a group with its members.',
    { name: string, members, admin: string }, ['name', 'members']),
  tool('update_group', 'update-room', 'Edit a group and its membership.',
    { id: string, ...roomProps, add: members, remove: members }, ['id']),
  tool('delete_group', 'delete-room', 'Delete a group.', { id: string }, ['id']),
  tool('list_conversations', 'space-conversations', 'Page Bot and group conversations.', pageProps),
  tool('get_conversation', 'space-conversation', 'Get conversation state.', { id: string }, ['id']),
  tool('read_messages', 'space-messages', 'Read a page of text messages; no files or attachments.',
    { id: string, cursor: { type: 'string', maxLength: 512 }, limit: pageProps.limit }, ['id']),
  tool('read_settings', 'space-settings', 'Read safe preferences and a page of available models.',
    pageProps),
  tool('recent_activity', 'space-activity', 'Page recent event metadata, without message bodies.',
    pageProps),
  tool('read_audit', 'space-audit', 'Page the recent audit window, newest first.', pageProps),
]
const digest = value => createHash('sha256').update(value).digest()
const invalid = () => Object.assign(new Error('Invalid agent access request'), {
  code: 'bot/invalid',
})
const matches = (value, schema) => {
  if (schema.anyOf) return schema.anyOf.some(option => matches(value, option))
  if (schema.type === 'integer') return Number.isSafeInteger(value)
    && value >= (schema.minimum ?? 0) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER)
  if (schema.type === 'null') return value === null
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems
    && value.every(item => matches(item, schema.items))
  if (schema.type === 'string') return typeof value === 'string' && value.length <= schema.maxLength
  return typeof value === schema.type
}
const validArgs = (args, schema) => args !== null && typeof args === 'object'
  && !Array.isArray(args) && schema.required.every(key => Object.hasOwn(args, key))
  && Object.entries(args).every(([key, value]) => Object.hasOwn(schema.properties, key)
    && matches(value, schema.properties[key]))

const readBody = async request => {
  if (!request.body?.getReader) return request.arrayBuffer()
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > LIMIT) {
        void reader.cancel().catch(() => {})
        throw Object.assign(new Error('Request too large'), { code: 'agent/oversize' })
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally { reader.releaseLock() }
}
const originAllowed = (origin, config) => {
  if (origin === null) return true
  if (!Array.isArray(config.agentAccessOrigins)) return false
  return config.agentAccessOrigins.some(value => {
    try { return value === origin && new URL(value).origin === value && /^https?:/.test(value) }
    catch { return false }
  })
}

export function agentBindAddress(value = '127.0.0.1') {
  try {
    const parsed = ipaddr.process(value)
    if (!['loopback', 'private', 'carrierGradeNat', 'uniqueLocal', 'linkLocal']
      .includes(parsed.range())) throw invalid()
    return parsed.toString()
  } catch { throw invalid() }
}

export function createAgentAccess(rt, handle, { now = Date.now, transaction = fn => fn(), multiuser = () => multiuserMode(), enterRequestOwnership } = {}) {
  const tokenPath = () => join(rt.home, 'agent-tokens.json')
  const auditPath = () => join(rt.home, 'agent-audit.jsonl')
  let records
  let queue = Promise.resolve()
  let server
  let address = null
  let stopped = false
  let failures = 0
  let resetAt = 0
  let auditQueue = Promise.resolve()
  const serial = fn => {
    const job = queue.then(fn)
    queue = job.catch(() => {})
    return job
  }
  const load = async () => {
    try {
      const value = JSON.parse(await readFile(tokenPath(), 'utf8'))
      if (!Array.isArray(value) || value.some(row => !/^[a-f0-9]{64}$/.test(row.hash)
        || typeof row.name !== 'string' || typeof row.id !== 'string')) throw invalid()
      records = value
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      records = []
    }
  }
  const redaction = createAgentRedactor(rt)
  const safeText = redaction.text
  const clean = redaction.clean
  const audit = entry => {
    const job = auditQueue.then(async () => {
      await redaction.refresh()
      await mkdir(rt.home, { recursive: true })
      await appendFile(auditPath(), JSON.stringify(clean({ time: now(), ...entry })) + '\n',
        { mode: 0o600 })
    })
    auditQueue = job.catch(() => {})
    return job
  }
  const persist = async next => {
    const temp = `${tokenPath()}.${randomUUID()}.tmp`
    await mkdir(rt.home, { recursive: true })
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 })
    await replaceFile(temp, tokenPath())
    records = next
  }
  const history = async () => {
    await redaction.refresh()
    try {
      const file = await open(auditPath(), 'r')
      try {
        const size = (await file.stat()).size
        const start = Math.max(0, size - 256 * 1024)
        const bytes = Buffer.alloc(size - start)
        await file.read(bytes, 0, bytes.length, start)
        const lines = bytes.toString('utf8').split('\n')
        if (start > 0) lines.shift()
        return clean(lines.filter(Boolean).slice(-200).map(line => JSON.parse(line)))
      } finally { await file.close() }
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  const snapshot = () => structuredClone({
    bots: Object.values(rt.state.bots).map(bot => botConfig(bot, rt.state.mainBotIds)),
    groups: Object.values(rt.state.rooms).map(roomConfig), mainBotIds: [...rt.state.mainBotIds],
  })
  const changes = (before, after) => {
    const diff = {}
    for (const kind of ['bots', 'groups']) {
      const left = new Map(before[kind].map(row => [row.id, row]))
      const right = new Map(after[kind].map(row => [row.id, row]))
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        const fields = {}
        const was = left.get(id) ?? {}
        const next = right.get(id) ?? {}
        for (const key of new Set([...Object.keys(was), ...Object.keys(next)])) {
          if (JSON.stringify(was[key]) !== JSON.stringify(next[key])) {
            fields[key] = { before: was[key] ?? null, after: next[key] ?? null }
          }
        }
        if (Object.keys(fields).length) (diff[kind] ??= {})[safeText(id)] = fields
      }
    }
    if (JSON.stringify(before.mainBotIds) !== JSON.stringify(after.mainBotIds)) {
      diff.mainBotIds = { before: before.mainBotIds, after: after.mainBotIds }
    }
    return diff
  }
  const json = (status, value) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      ...(status === 405 ? { allow: 'POST' } : {}) },
  })
  const authenticate = candidate => serial(async () => {
    await load()
    const hash = digest(candidate)
    let identity
    for (const row of records) {
      if (timingSafeEqual(hash, Buffer.from(row.hash, 'hex'))) identity = row
    }
    return identity
  })
  const processRequest = async (request, context) => {
    await redaction.refresh()
    const supplied = request.headers.get('authorization') ?? ''
    const candidate = supplied.startsWith('Bearer ') ? supplied.slice(7) : ''
    const identity = await authenticate(candidate)
    const tokenName = identity?.name ?? 'Unknown token'
    const callId = randomUUID()
    const entry = { callId, tokenName, action: 'http', target: null }
    context.entry = entry
    const refuse = async (status, reason) => {
      await audit({ ...entry, outcome: 'refused', reason })
      return json(status, { error: reason })
    }
    if (!identity || identity.revokedAt !== undefined || candidate === '') {
      if (now() >= resetAt) { failures = 0; resetAt = now() + 60000 }
      failures += 1
      return refuse(failures > 10 ? 429 : 401,
        failures > 10 ? 'Too many failed attempts' : 'Invalid agent token')
    }
    let url
    try { url = new URL(request.url) } catch { return refuse(400, 'Invalid MCP URL') }
    if (!['/mcp', MCP_PATH].includes(url.pathname) || url.search
      || !originAllowed(request.headers.get('origin'), rt.config)) {
      return refuse(403, 'Invalid MCP origin or URL')
    }
    if (request.method !== 'POST') return refuse(405, 'Use POST')
    const version = request.headers.get('mcp-protocol-version')
    if (version && !VERSIONS.has(version)) return refuse(400, 'Unsupported protocol version')
    const accept = request.headers.get('accept') ?? ''
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return refuse(406, 'Accept JSON and event streams')
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return refuse(415, 'Use application/json')
    }
    let body
    let bodyError
    try {
      const bytes = await readBody(request)
      if (bytes.byteLength > LIMIT) bodyError = 'Request too large'
      else body = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch (error) {
      bodyError = error.code === 'agent/oversize' ? 'Request too large' : 'Invalid JSON'
    }
    const method = body?.method
    const definition = method === 'tools/call'
      ? AGENT_TOOLS.find(item => item.name === body.params?.name) : undefined
    if (definition) {
      entry.action = definition.name
      const target = body.params?.arguments?.id
      entry.target = typeof target === 'string' ? target : null
    } else if (['initialize', 'ping', 'tools/list'].includes(method)) entry.action = method
    if (bodyError) return refuse(bodyError === 'Request too large' ? 413 : 400, bodyError)
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
      || (body.id !== undefined && typeof body.id !== 'string' && typeof body.id !== 'number')) {
      return refuse(400, 'Invalid JSON-RPC request')
    }
    const knownMethods = ['initialize', 'ping', 'tools/list', 'tools/call',
      'notifications/initialized', 'notifications/cancelled']
    entry.action = knownMethods.includes(body.method) ? body.method : 'unknown-method'
    const replyId = () => typeof body.id === 'string' ? safeText(body.id) : body.id
    const reply = async result => {
      await redaction.refresh()
      // Keep protocol/schema literals intact, even when a short secret is "text".
      // Tool content is JSON data inside a text envelope; clean before encoding it.
      if (result.content) result = { ...result, content: result.content.map(item => ({
        ...item, text: JSON.stringify(clean(JSON.parse(item.text))),
      })) }
      return json(200, { jsonrpc: '2.0', id: replyId(), result })
    }
    const error = async (code, message) => {
      await audit({ ...entry, outcome: 'refused', reason: message })
      return json(200, { jsonrpc: '2.0', id: replyId() ?? null,
        error: { code, message: safeText(message) } })
    }
    if (body.method.startsWith('notifications/') && body.id === undefined) {
      if (!knownMethods.includes(body.method)) return refuse(400, 'Unknown notification')
      await audit({ ...entry, outcome: 'allowed' })
      return new Response(null, { status: 202 })
    }
    if (body.id === undefined) return refuse(400, 'Request id required')
    if (body.method !== 'tools/call') {
      let result
      if (body.method === 'initialize') result = {
        protocolVersion: VERSIONS.has(body.params?.protocolVersion)
          ? body.params.protocolVersion : VERSION,
        capabilities: { tools: {} }, serverInfo: { name: 'automagik-bots', version: '1' },
      }
      else if (body.method === 'ping') result = {}
      else if (body.method === 'tools/list') result = {
        tools: AGENT_TOOLS.map(({ endpoint, read, ...item }) => item),
      }
      else return error(-32601, 'Unknown method')
      await audit({ ...entry, outcome: 'allowed' })
      return reply(result)
    }
    if (!definition) return error(-32602, 'Unknown tool')
    entry.action = definition.name
    const args = body.params?.arguments ?? {}
    entry.target = typeof args?.id === 'string' ? args.id : null
    if (!validArgs(args, definition.inputSchema)) return error(-32602, 'Invalid tool arguments')
    if (definition.read) {
      const current = await authenticate(candidate)
      if (!current || current.revokedAt !== undefined) return refuse(401, 'Invalid agent token')
      const result = await handle(definition.endpoint, clean(args), request.signal)
      await audit({ ...entry, outcome: result.ok ? 'allowed' : 'refused' })
      const value = clean(result.ok ? result.value
        : { error: 'Read refused', code: result.error.code })
      return reply({ isError: !result.ok, content: [
        { type: 'text', text: JSON.stringify(value) },
      ] })
    }
    const leave = enterRequestOwnership?.(definition.endpoint, args)
    try {
      return await transaction(async () => {
        const current = await authenticate(candidate)
        if (!current || current.revokedAt !== undefined) return refuse(401, 'Invalid agent token')
        await rt.refresh()
        const before = snapshot()
        // An intent persists before side effects. Audit failure therefore fails closed.
        await audit({ ...entry, outcome: 'started' })
        const result = await handle(definition.endpoint, clean(args), request.signal)
        const after = snapshot()
        const delta = changes(before, after)
        if (args.id === undefined && definition.endpoint === 'create-bot') {
          entry.target = result.ok ? result.value.id : null
        }
        if (args.id === undefined && definition.endpoint === 'create-room') {
          entry.target = result.ok ? result.value.id : null
        }
        await audit({ ...entry, outcome: result.ok ? 'allowed' : 'refused', changes: delta })
        // Mutation handlers may answer a full UI view. Never send that view over MCP.
        const target = args.id ?? entry.target
        const value = clean(result.ok
          ? definition.endpoint.endsWith('bot') || definition.endpoint === 'set-main'
            ? after.bots.find(bot => bot.id === target) ?? null
            : after.groups.find(group => group.id === target) ?? null
          : { error: 'Action refused', code: result.error.code })
        return reply({ isError: !result.ok, content: [
          { type: 'text', text: JSON.stringify(value) },
        ] })
      })
    } finally { leave?.() }
  }
  const fetch = async request => {
    if (multiuser()) return json(403, { error: 'Agent access is off in multiuser mode' })
    const context = {}
    try { return await processRequest(request, context) }
    catch {
      try {
        await audit({ tokenName: 'Unknown token', action: 'http', target: null,
          ...context.entry, outcome: 'refused', reason: 'Agent access unavailable' })
      } catch { /* An unavailable audit always refuses the request. */ }
      return json(503, { error: 'Agent access unavailable' })
    }
  }
  const start = async () => {
    if (server || stopped) return
    const host = agentBindAddress(rt.config.agentAccessHost)
    const port = rt.config.agentAccessPort ?? 0
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid()
    server = createServer(async (req, res) => {
      try {
        const response = await fetch({
          url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}${req.url}`,
          method: req.method, headers: new Headers(req.headers),
          arrayBuffer: async () => {
            let size = 0
            const chunks = []
            for await (const chunk of req) {
              size += chunk.length
              if (size <= LIMIT) chunks.push(chunk)
            }
            if (size > LIMIT) throw Object.assign(new Error('Request too large'), {
              code: 'agent/oversize',
            })
            return Buffer.concat(chunks)
          },
        })
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch { res.writeHead(503).end() }
    })
    server.requestTimeout = 10000
    server.headersTimeout = 10000
    server.maxConnections = 32
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      address = server.address()
      server.unref()
    } catch (error) { server = undefined; throw error }
  }
  const owner = (action, payload = {}) => serial(async () => {
    await load()
    if (rt.readOnly() !== undefined) throw invalid()
    await redaction.refresh()
    if (action === 'view') return clean({
      url: address ? `http://${address.family === 'IPv6'
        ? `[${address.address}]` : address.address}:${address.port}/mcp` : null,
      webPath: MCP_PATH,
      tokens: records.map(({ hash, ...row }) => row), audit: await history(),
    })
    if (action === 'create') {
      if (typeof payload.name !== 'string' || !/^[\w .-]{1,60}$/.test(payload.name)
        || records.filter(row => row.revokedAt === undefined).length >= 100) throw invalid()
      const token = `am_agent_${randomBytes(32).toString('hex')}`
      const row = { id: randomUUID(), name: clean(payload.name),
        hash: digest(token).toString('hex'),
        createdAt: now() }
      await start()
      await persist([...records, row])
      return { id: row.id, token }
    }
    if (action === 'revoke') {
      if (!records.some(row => row.id === payload.id)) throw invalid()
      await persist(records.map(row => row.id === payload.id ? { ...row, revokedAt: now() } : row))
      return true
    }
    throw invalid()
  })
  const resume = () => serial(async () => {
    await load()
    if (!records.some(row => row.revokedAt === undefined)) return
    await rt.load()
    if (rt.readOnly() === undefined) await start()
  })
  const close = async () => {
    stopped = true
    await queue
    await auditQueue
    if (server) await new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
  return { owner, fetch, resume, close, history }
}
