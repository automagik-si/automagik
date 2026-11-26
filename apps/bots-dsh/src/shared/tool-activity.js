import { redactText } from '../host/redact.js'

export const TOOL_ACTIVITY = 'tool-activity'
export const BRIDGE_ACTIVITY_RECORD = 'plugin:acp-dsh/bridge-outside-step'

const knownTools = new Set([
  'apply_patch', 'ask_user', 'ask_user_question', 'bash', 'browser_handoff', 'computer_handoff',
  'create_bot', 'create_group', 'delete_bot', 'delete_group', 'edit', 'fetch', 'forget', 'generate_image',
  'glob', 'grep', 'group_relay', 'list_bots', 'list_dir', 'list_groups', 'list_secrets', 'mail_send',
  'message_bot', 'post_to_group', 'propose_bot_change', 'pwsh', 'read', 'read_file', 'read_group_chat', 'read_image',
  'read_own_chat', 'recall', 'remember', 'request_connector', 'request_secret', 'show_settings',
  'show_view', 'start_task', 'stop_bot', 'str_replace_editor', 'subagent', 'update_bot', 'update_group',
  'web_fetch', 'web_search', 'write',
])
const acpOperations = new Map([
  ['execute', 'shell'], ['read', 'read'], ['edit', 'edit'], ['delete', 'delete'],
  ['move', 'move'], ['search', 'search'], ['fetch', 'fetch'],
])
const fileTools = new Set(['read', 'read_file', 'read_image', 'write', 'edit', 'delete', 'move', 'str_replace_editor', 'list_dir'])
const webTools = new Set(['fetch', 'web_fetch'])
const identifiedAcpPlugins = new Set(['mcp__github__create_issue', 'mcp__linear__get_issue'])
const privateShape = /(?:^|[./\\_-])(?:password|passwd|credential[s]?|secret[s]?|token[s]?|authorization|auth[_-]?token|api[_-]?key|private[_-]?key|gh[pousr]_|github_pat_|sk[-_]|xox[baprs]-|npm_|\.env(?:$|[./\\])|\.npmrc(?:$|[./\\]))/i
const safeText = value => !privateShape.test(value) && redactText(value) === value
const own = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined

export const isSkillTool = name => name === 'load_skill' || name === 'mcp__dsh__load_skill'

function argsOf(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function basenameOf(path) {
  if (typeof path !== 'string' || path.length > 4096 || !/^(?:[A-Za-z]:[\\/])?[A-Za-z0-9._/\\ -]+$/.test(path) || !safeText(path)) return
  const name = path.split(/[\\/]/).at(-1)
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(name) && name === name.trim() ? name : undefined
}

function hostnameOf(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\/[^\s\\]+$/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) return
  try {
    const host = new URL(value).hostname
    if (/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(host) && host.length <= 80 && safeText(host)) return host
  } catch {}
}

function pluginOf(name) {
  if (name.length > 64 || !safeText(name)) return
  const match = /^mcp__([a-z0-9]+(?:[-_][a-z0-9]+)*)__((?:[a-z0-9]+[-_.])*[a-z0-9]+)$/i.exec(name)
  if (match && match[1] !== 'dsh') return { label: 'plugin', name: `${match[1]} · ${match[2]}` }
}

// Tool names from the call envelope are distinct from an ACP mirror's free-form title.
// The latter only identifies an operation when it matches a known structured MCP name.
export function toolActivityOf({ name: raw, arguments: args }) {
  if (typeof raw !== 'string' || raw === '' || raw === 'ToolSearch' || isSkillTool(raw)) return
  const tool = raw.startsWith('mcp__dsh__') ? raw.slice('mcp__dsh__'.length) : raw
  if (tool === 'run_code' || tool === 'ToolSearch') return
  const data = argsOf(args)
  const acp = tool === 'acp_tool'
  const title = own(data, 'title')
  const input = acp ? own(data, 'input') : data
  if (acp) {
    const server = own(input, 'server')
    const operation = own(input, 'tool')
    if (typeof server === 'string' && typeof operation === 'string') {
      const plugin = pluginOf('mcp__' + server + '__' + operation)
      if (plugin) return plugin
    }
    if (identifiedAcpPlugins.has(title)) return pluginOf(title)
  }
  if (!acp && raw.startsWith('mcp__') && raw === tool) return pluginOf(raw) ?? { label: 'plugin', name: 'tool' }
  const name = acp ? acpOperations.get(own(data, 'kind')) ?? 'tool' : knownTools.has(tool) ? tool : 'tool'
  const path = own(input, 'file_path') ?? own(input, 'path') ?? own(input, 'notebook_path') ??
    (acp ? own(own(data, 'locations')?.[0], 'path') : undefined)
  const target = fileTools.has(name) ? basenameOf(path) : webTools.has(name) ? hostnameOf(own(input, 'url')) : undefined
  return { label: 'tool', name, ...(target === undefined ? {} : { target }) }
}

export function toolEventOf(event) {
  const { type, data, seq, time } = event ?? {}
  if (!Number.isSafeInteger(seq) || seq < 0) return
  let id
  if (type === 'tool/call') id = data?.callId
  else if (type === 'tool/ptc-dispatch-start') id = data?.subCallId
  else if (type === BRIDGE_ACTIVITY_RECORD && event.ignorable === true && data?.outcome === 'ran') id = data.callId
  if (typeof id !== 'string' || id === '') return
  const activity = toolActivityOf(data)
  if (activity !== undefined) return { kind: TOOL_ACTIVITY, ...activity, id, seq, time }
}
