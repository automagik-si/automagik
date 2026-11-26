import ipaddr from 'ipaddr.js'
import { SKILL_RULE_REASONS } from '../shared/skill-rule-reasons.js'
import { looksLikeKey, looksSecret } from './memory-entries.js'
import { credentialShapes } from './redact.js'
import { LIMITS, portableKey, skillHash, skillName, skillPath, textSkillFields } from './skill-library-rules.js'
import { SKILL_CHECK_FINGERPRINT, SKILL_CHECK_VERSION } from './skill-check-version.js'

export { SKILL_CHECK_FINGERPRINT, SKILL_CHECK_HISTORY, SKILL_CHECK_VERSION } from './skill-check-version.js'
export { LIMITS as SKILL_LIMITS } from './skill-library-rules.js'

const rule = (id, level, area, patterns = []) => Object.freeze({
  id, key: `skill.rule-${id}`, level, area, reason: SKILL_RULE_REASONS[id], patterns: Object.freeze(patterns),
})
const structure = (id) => rule(id, 'block', 'structure')
const dangerous = (id, level, patterns) => rule(id, level, 'dangerous-commands', patterns)

export const SKILL_CHECK_RULES = Object.freeze([
  structure('skill-md-missing'),
  structure('frontmatter-invalid'),
  structure('name-invalid'),
  structure('name-mismatch'),
  structure('description-missing'),
  structure('description-long'),
  structure('path-dotdot'),
  structure('path-absolute'),
  structure('path-invalid'),
  structure('path-long'),
  structure('path-deep'),
  structure('path-duplicate'),
  structure('not-regular'),
  structure('too-many-files'),
  structure('file-large'),
  structure('total-large'),
  structure('skill-md-large'),
  structure('utf8-invalid'),
  rule('secret-shape', 'block', 'secrets'),
  rule('secret-key', 'block', 'secrets'),
  rule('secret-given', 'block', 'secrets'),
  rule('invisible-char', 'block', 'prompt-injection', [
    // eslint-disable-next-line no-control-regex -- The gate intentionally detects invisible control characters.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u,
  ]),
  rule('approval-off', 'block', 'prompt-injection', [
    /\b(?:turn off|disable|bypass|skip|ignore)\b[^\n]{0,50}\b(?:approvals?|permission prompts?|sandbox|confirmations?)\b/i,
    /--(?:dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|yolo)\b|\bbypassPermissions\b|\b(?:approval_policy\s{0,10}=\s{0,10}["']never|sandbox_mode\s{0,10}=\s{0,10}["']danger-full-access)/i,
  ]),
  rule('raise-level', 'block', 'prompt-injection', [
    /\b(?:raise|set|change|increase)\b[^\n]{0,60}\b(?:permissions?|approval|access) levels?\b|\bgrant (?:yourself|itself)\b/i,
  ]),
  rule('hide-action', 'block', 'prompt-injection', [
    /\b(?:do not tell|without telling|never mention|hide)\b[^\n]{0,120}\b(?:user|person|owner|human)\b|\bsilently so the user does not notice\b/i,
  ]),
  rule('exfiltration', 'block', 'prompt-injection', [
    /(?:\b(?:curl|wget)\b[^\n]{0,350} (?:-d|-F|-T|--data|--form|--upload-file|--post-data|--post-file)|\b(?:nc|ncat|scp|requests\.post)\b|\brsync\b[^\n]{0,200}:|\b(?:Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,250} (?:-Body|-InFile|-Method Post)|\bfetch\([^\n]{0,250}\bmethod:\s{0,5}['"]POST|\b(?:send|upload|post|email|forward)\b[^\n]{0,100}\bto\b)/i,
  ]),
  dangerous('pipe-to-shell', 'block', [
    /\b(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,800}\|\s{0,20}(?:sudo\s{1,10})?(?:sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|iex|Invoke-Expression|powershell|pwsh)\b|\b(?:sh|bash|zsh|iex)\s{1,20}(?:-c\s{1,20}["']?\$|<)?\(\s{0,20}(?:curl|wget|iwr|irm)\b/i,
  ]),
  dangerous('reverse-shell', 'block', [
    /\/dev\/(?:tcp|udp)\/|\b(?:nc|ncat|netcat)\b[^\n]{0,160}\s-[ec]\b|\bsocat\b[^\n]{0,160}\bexec:|\bbash -i\s{0,20}>&|\bmkfifo\b[^\n]{0,200}\b(?:nc|ncat)\b|\bpty\.spawn\b[^\n]{0,200}\bsocket\b|Net\.Sockets\.TCPClient[^\n]{0,200}GetStream/i,
  ]),
  dangerous('wipe', 'block', [
    /\brm\s{1,20}-[rfRF]{1,6}\s{1,20}["']?(?:\/\*?|~|\$HOME)(?=["'\s;|&]|$)|--no-preserve-root|\b(?:mkfs|wipefs|diskpart)\b|(?:\bof=|>\s{0,10})\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)|\bshred\b[^\n]{0,160}\/dev\/|\bformat\s{1,20}[A-Z]:|\bRemove-Item\b[^\n]{0,160}-Recurse[^\n]{0,100}(?:[A-Z]:\\|~|\$HOME|\$env:USERPROFILE)|:\(\)\s{0,10}\{/i,
  ]),
  dangerous('system-write', 'block', [
    /(?:>{1,2}\s{0,20}|\b(?:tee|cp|mv|install|ln|chmod|chown|sed -i)\s{1,20}[^\n]{0,300}?)[ "'=]?(?:\/(?:etc|boot|usr|bin|sbin|lib64?|sys|proc\/sys|System|Library|efi)\b|[A-Z]:\\Windows\b)/i,
  ]),
  dangerous('credential-store', 'block', [
    /(?:Login Data|Local State|cookies\.sqlite|key4\.db|logins\.json|login\.keychain(?:-db)?|\b(?:Chrome|Chromium|Edge|Brave)[^\n]{0,100}\bCookies\b|\bsecurity find-(?:generic|internet)-password\b[^\n]{0,200}\s-[wg]\b|\bsecret-tool lookup\b|\b(?:op (?:read|run|inject|item get)|bw (?:get|list|export|unlock|serve)|bws (?:secret (?:get|list)|run)|vault (?:read|kv get|kv list|list|token lookup|token create|print token)|pass(?:-cli)? (?:show|item (?:view|get|run|show|totp|attachment)|inject|export)|keepassxc-cli (?:show|clip|export)|secret-tool (?:lookup|search))\b|\.(?:claude\/(?:\.credentials\.json)|codex\/auth\.json|gemini\/oauth_creds\.json|aws\/credentials|kube\/config|docker\/config\.json|netrc\b|git-credentials\b)|\bgcloud\/application_default_credentials\.json|\bgh\/hosts\.yml|\.ssh\/id_[\w-]{1,40}(?![\w.-]))/i,
  ]),
  rule('endpoint-credential', 'block', 'external-endpoints'),
  rule('endpoint-local', 'block', 'external-endpoints'),
  rule('binary-executable', 'block', 'scripts-binaries'),
  rule('decode-eval', 'block', 'scripts-binaries', [
    /\b(?:eval|exec|Function|iex)\s{0,20}\(?[^\n]{0,250}\b(?:atob|b64decode|decode_base64|Buffer\.from|decompress|codecs\.decode|marshal\.loads|FromBase64String|String\.fromCharCode)\b|\bbase64\s{1,20}(?:-d|--decode)[^\n]{0,250}\|\s{0,20}(?:sh|bash|zsh)\b|\s-(?:EncodedCommand|enc)\b/i,
  ]),
  rule('unusual-place', 'warn', 'structure'),
  rule('hidden-file', 'warn', 'structure'),
  rule('binary-file', 'warn', 'structure'),
  rule('override', 'warn', 'prompt-injection', [
    /\b(?:ignore|disregard) (?:the )?(?:previous|prior|earlier|above) instructions\b|\b(?:forget your instructions|you are now|pretend to be|your new (?:role|identity|name) is)\b|\bthis skill (?:overrides|takes precedence over|is above)\b/i,
  ]),
  rule('encoded-blob', 'warn', 'prompt-injection', [
    /(?:[A-Za-z0-9+/]{200}|[a-f0-9]{200}|data:[\w.+/-]{1,80};base64,)/i,
  ]),
  dangerous('sudo', 'warn', [/\bsudo\b/]),
  dangerous('recursive-delete', 'warn', [/\brm\s{1,20}-[A-Za-z]{0,10}[rR]|\bRemove-Item\b[^\n]{0,200}-Recurse/i]),
  dangerous('package-install', 'warn', [
    /\b(?:(?:npm|pnpm|yarn|bun) (?:add|install|i)|npx -y|(?:pip3?|uv pip|pipx|gem|cargo|go|brew|apt|apt-get|dnf|yum|choco|winget) install|pacman -S)\b/i,
  ]),
  dangerous('crontab', 'warn', [/\b(?:crontab|launchctl load|schtasks \/create)\b|\/etc\/cron/i]),
  dangerous('shell-start-file', 'warn', [
    /(?:>{1,2}|\b(?:tee|cp|mv|install|sed -i)\b)[^\n]{0,200}(?:\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b|\bconfig\.fish\b|\$PROFILE\b)/i,
  ]),
  dangerous('service', 'warn', [
    /\bsystemctl\s{1,10}(?:enable|start|restart|daemon-reload)\b|\b(?:launchctl|sc create|New-Service|update-rc\.d)\b|\bservice\s{1,10}[\w.-]{1,60}\s{1,10}start\b|\bsystemd\//i,
  ]),
  rule('endpoint', 'warn', 'external-endpoints'),
  rule('endpoint-dynamic', 'warn', 'external-endpoints'),
  rule('script', 'warn', 'scripts-binaries'),
  rule('run-or-grant', 'warn', 'run-or-grant'),
])
const RULES = new Map(SKILL_CHECK_RULES.map(value => [value.id, value]))
const PER_LINE = SKILL_CHECK_RULES.filter(value => value.patterns.length && value.id !== 'exfiltration')
const INSTRUCTIONS = /\.(?:md|markdown|txt)$/i
const TEXT = /\.(?:md|markdown|txt|sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|lua|ps1|psm1|bat|cmd|json|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|svg|sql|env\.example)$/i
const SCRIPT = Object.freeze({
  sh: 'sh', bash: 'bash', zsh: 'zsh', fish: 'fish', py: 'python3', js: 'node', mjs: 'node',
  cjs: 'node', ts: 'node', rb: 'ruby', pl: 'perl', php: 'php', lua: 'lua', ps1: 'pwsh',
  psm1: 'pwsh', bat: 'cmd', cmd: 'cmd',
})
const GRANTS = new Set(['allowed-tools', 'hooks', 'context', 'agent', 'model', 'shell', 'permissionMode'])
const DATA_URI = /\bdata:[\w.+/-]{1,80};base64,(?=[A-Za-z0-9+/=])/gi
const ENCODED_BYTE = /[A-Za-z0-9+/=]/
const PLACEHOLDER = /(?<![A-Za-z0-9_.+~/-])(?:\$DSH_SECRET_[A-Z0-9_]{1,200}\b|\$\{[A-Z_][A-Z0-9_]{0,199}\}|\$[A-Z_][A-Z0-9_]{0,199}\b|<[^<>\s]{1,40}>|\{\{[^{}\s]{1,40}\}\}|\b(?:YOUR_[A-Z_]{1,200}|[xX]{3,4352})\b|(?<!\*)\*{3,4352})(?![A-Za-z0-9_+~/\-*]|\.[A-Za-z0-9_])/g
// Skip the shared redactor's account-specific patterns on windows with no
// credential label, credential prefix, authorization scheme, or URL authority.
const SHAPE_CANDIDATE = /(?:\b(?:sk-|gh[opusr]_|github_pat_|AKIA|xox[baprs]-|AIza|eyJ|Bearer|Basic|[sr]k_|whsec_|hf_|gl(?:pat|oas|rt)-|gsk_|r8_|dop_v1_|shp(?:at|ca|pa|ss)_|SG\.|ya29\.|nfp_|vercel_|sbp_|ATBB|npm_|npm_config_)|[?&#]|@|(?:api[_-]?key|authorization|authToken|token|secret|passw(?:or)?d|\b(?:auth|pwd)))/i
const URL = /\b(?:https?|wss?|ftp|sftp|ssh|git|s3|gs):\/\/(?:\[[^\]\s]{1,100}\]|\$\{[^}\s]{1,100}\}|<[^>\s]{1,100}>|[^\s<>"'`)\]]{1,4352})[^\s<>"'`)\]]{0,4352}/gi
const COMMAND_HOST = /\b(ssh|scp|nc|ncat|telnet|socat)(?:\s+-[^\s]{1,32}){0,8}\s+((?:[\w.-]{1,64}@)?(?:\[[\da-f:]{2,80}\]|[\w.$-]{1,253}))(?=[:\s;|&]|$)/gi
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const digestOrder = (a, b) => byteOrder(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || byteOrder(a.rule, b.rule)

function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value)
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('Unclosed quote')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

export function parseSkillMd(bytes) {
  try {
    const canonical = textSkillFields(bytes)
    return { ok: true, ...canonical, fields: { name: canonical.name, description: canonical.description } }
  } catch { /* A file does not have to use the text form's formatting. */ }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n')
    const lines = text.split('\n', 201)
    const end = lines.indexOf('---', 1)
    if (lines[0] !== '---' || end < 1 || end >= 200) return { ok: false }
    const fields = Object.create(null)
    for (let i = 1; i < end; i++) {
      if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue
      const match = /^([\w-]+):\s*(.*?)\s*$/.exec(lines[i])
      if (!match || Object.hasOwn(fields, match[1])) return { ok: false }
      const [, key, value] = match
      const continued = []
      while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !value && lines[i + 1].startsWith('- '))) {
        continued.push(lines[++i].trim())
      }
      if (value === '>' || value === '|') fields[key] = continued.join(value === '>' ? ' ' : '\n')
      else if (value.startsWith('[') && value.endsWith(']')) fields[key] = value.slice(1, -1).split(',').map(part => scalar(part.trim()))
      else if (!value && continued.every(part => part.startsWith('- ')) && continued.length) fields[key] = continued.map(part => scalar(part.slice(2)))
      else {
        if (continued.length) return { ok: false }
        fields[key] = scalar(value)
      }
    }
    return { ok: true, name: fields.name, description: fields.description, fields, body: text.split('\n').slice(end + 1).join('\n').replace(/^\n|\n$/g, '') }
  } catch { return { ok: false } }
}

function executable(bytes) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 64))
  if (head.length < 4) return false
  if ([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head.readUInt32BE())) return true
  if (head.length !== 64 || head.readUInt16BE() !== 0x4d5a) return false
  const offset = head.readUInt32LE(60)
  return offset + 4 <= bytes.length && Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).readUInt32BE() === 0x50450000
}

export function skillFileText(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? undefined : text
  } catch { return undefined }
}

function localHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$|\.$/g, '')
  if (ipaddr.isValid(value)) return ipaddr.process(value).range() !== 'unicast'
  return !value.includes('.') || /(?:\.(?:localhost|local|internal|home\.arpa|lan)$|^metadata\.goog$)/.test(value)
}

function withoutDataUris(line) {
  if (!line.toLowerCase().includes('data:')) return line
  const parts = []
  let next = 0
  for (let offset = 0; offset < line.length; offset += 4096) {
    const window = line.slice(offset, offset + 4352)
    for (const match of window.matchAll(DATA_URI)) {
      const start = offset + match.index
      if (start < next) continue
      parts.push(line.slice(next, start), ' ')
      next = start + match[0].length
      while (next < line.length && ENCODED_BYTE.test(line[next])) next++
    }
  }
  return parts.length ? parts.join('') + line.slice(next) : line
}

function nearSecrets(raw) {
  // Test independent tokens as well as the line: an exemption cannot hide a nearby value.
  const shaped = raw.replace(PLACEHOLDER, '""').replace(/\b(?:Bearer|Basic)\s{1,20}""/gi, '""')
  const masked = shaped.replaceAll('""', ' ')
  return {
    shaped: SHAPE_CANDIDATE.test(raw) && credentialShapes(raw) !== raw
      && credentialShapes(shaped) !== shaped,
    key: looksLikeKey(masked),
    disclosed: looksSecret(masked.replace(/`[^`]{0,4350}`/g, ' ')),
  }
}

function scanFile(entry, finding, uses, unusual) {
  const { path, bytes } = entry
  const add = (id, line = null, detail) => finding(id, path, line, detail)
  const top = path.split('/')[0]
  if (top !== path && !['scripts', 'references', 'assets'].includes(top) && !unusual.has(top)) {
    unusual.add(top)
    add('unusual-place')
  }
  if (path.split('/').some(part => part.startsWith('.'))) add('hidden-file')
  if (executable(bytes)) add('binary-executable')
  const shebang = bytes[0] === 35 && bytes[1] === 33
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  const text = skillFileText(bytes)
  if (text === undefined) {
    if (TEXT.test(path) || shebang) add('utf8-invalid')
    else if (top !== 'assets') add('binary-file')
    return
  }
  if (shebang || top === 'scripts' || Object.hasOwn(SCRIPT, extension)) {
    const start = /^#![^\S\n]{0,20}(?:[\w./-]{0,100}\/)?(?:env\s{1,10}(?:-S\s{1,10})?)?([\w.-]{1,40})/.exec(text)?.[1]
    const safe = start && credentialShapes(start) === start && !looksLikeKey(start)
    const interpreter = (safe ? start : undefined) ?? SCRIPT[extension] ?? 'unknown'
    uses.scripts.push({ path, interpreter, size: bytes.byteLength })
    add('script', null, interpreter)
  }
  const instruction = INSTRUCTIONS.test(path)
  const blocksEncoding = !instruction || top === 'scripts' || top === 'references'
  let fenced = false
  let paragraphLines = 0
  let credentialLine = false
  let sendLine = false
  let paragraphReported = false
  const endpoint = (scheme, raw, line, hits) => {
    if (/^\w{1,24}:\/\/(?:[^/]*[${<])/.test(raw)) return hits.add('endpoint-dynamic')
    let address
    try { address = new globalThis.URL(raw) } catch { return }
    if (!address.hostname) return
    if (address.username || address.password) return hits.add('endpoint-credential')
    if (localHost(address.hostname)) return hits.add('endpoint-local')
    const origin = `${scheme}://${address.host}`
    if (uses.origins.has(origin)) return
    uses.origins.add(origin)
    if (uses.endpoints.size < 100) uses.endpoints.add(origin)
    add('endpoint', line, origin)
  }
  let line = 0
  for (const source of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    line++
    const value = source[0].replace(/\r?\n$/, '')
    const blank = !value.trim()
    if (blank || paragraphLines === 20) {
      paragraphLines = 0
      credentialLine = sendLine = paragraphReported = false
    }
    if (blank) continue
    paragraphLines++
    if (/^\s{0,3}(?:```|~~~)/.test(value)) fenced = !fenced
    const hits = new Set()
    const secretText = instruction ? withoutDataUris(value) : value
    for (let offset = 0; offset < secretText.length; offset += 4096) {
      const window = secretText.slice(offset, offset + 4352)
      const { shaped, key, disclosed } = nearSecrets(window)
      if (shaped) hits.add('secret-shape')
      if (key || (blocksEncoding && /[A-Za-z0-9+/]{200}/.test(window))) hits.add('secret-key')
      if (!fenced && !key && disclosed) hits.add('secret-given')
    }
    for (let offset = 0; offset < value.length; offset += 4096) {
      const window = value.slice(offset, offset + 4352)
      for (const rule of PER_LINE) {
        if (rule.area === 'prompt-injection' && rule.id !== 'invisible-char' && !instruction) continue
        if (rule.patterns.some(pattern => pattern.test(window))) hits.add(rule.id)
      }
      for (const match of window.matchAll(URL)) endpoint(match[0].split(':', 1)[0].toLowerCase(), match[0], line, hits)
      for (const [, scheme, host] of window.matchAll(COMMAND_HOST)) {
        // A username is normal in a shell target. A password in a URL is not.
        endpoint(scheme.toLowerCase(), `${scheme}://${host.split('@').at(-1)}`, line, hits)
      }
      for (const [, name] of window.matchAll(/\$DSH_SECRET_([A-Z][A-Z0-9_]{0,199})\b/g)) uses.secrets.add(name)
      for (const [token, quoted] of window.matchAll(/`([a-z][a-z0-9]{0,40}(?:_[a-z0-9]{1,40}){1,8})`|\bmcp__[a-z0-9_]{1,100}\b/g)) {
        if (uses.tools.size < 50) uses.tools.add(quoted ?? token)
      }
      if (path === 'SKILL.md' && /!`[^`]{1,4096}`/.test(window)) {
        add('run-or-grant', line, 'inline-command')
      }
      if (instruction && !paragraphReported) {
        credentialLine ||= hits.has('credential-store') || /(?:\.env\b|~\/\.ssh|\b(?:printenv|env|process\.env|os\.environ)\b|\$DSH_SECRET_)/.test(window)
        sendLine ||= RULES.get('exfiltration').patterns.some(pattern => pattern.test(window))
        if (credentialLine && sendLine) {
          hits.add('exfiltration')
          paragraphReported = true
        }
      }
    }
    for (const id of hits) add(id, line)
  }
}

export function checkSkill(entries, { expectedName, legacy = false } = {}) {
  const findings = []
  const injection = []
  const counts = { block: 0, warn: 0 }
  const retained = new Map()
  let truncated = false
  function add(id, path, line = null, detail, level = RULES.get(id).level) {
    const { key, area, reason } = RULES.get(id)
    if (area === 'prompt-injection' && !injection.some(finding => finding.rule === id)) {
      injection.push({ rule: id, key, level, area, path, line, reason })
    }
    const identity = `${path}\0${id}`
    counts[level]++
    const count = retained.get(identity) ?? 0
    if (count === 20 || findings.length === 300) {
      truncated = true
      return
    }
    retained.set(identity, count + 1)
    findings.push({ rule: id, key, level, area, path, line, reason, ...(detail === undefined ? {} : { detail }) })
  }
  const files = entries.filter(entry => entry.type !== 'dir').sort((a, b) => byteOrder(a.path, b.path))
  const bytesFiles = files.filter(entry => entry.bytes instanceof Uint8Array)
  const hash = skillHash(bytesFiles)
  const uses = { tools: new Set(), scripts: [], endpoints: new Set(), secrets: new Set(), origins: new Set() }
  const frontmatter = {}
  const paths = new Map()
  let total = 0
  if (files.length > LIMITS.files) add('too-many-files', 'SKILL.md')
  const ordered = [...entries].sort((a, b) => byteOrder(a.path, b.path))
  for (const { path, type, bytes } of ordered) {
    const parts = path.split('/')
    if (parts.includes('..')) add('path-dotdot', path)
    else if (/^(?:\/|\\\\|[a-z]:)/i.test(path)) add('path-absolute', path)
    else if (Buffer.byteLength(path) > LIMITS.pathBytes) add('path-long', path)
    else if (parts.length > LIMITS.depth) add('path-deep', path)
    else if (!skillPath(path)) add('path-invalid', path)
    for (let n = 1; n <= parts.length; n++) {
      const spelling = parts.slice(0, n).join('/')
      const key = portableKey(spelling)
      const file = n === parts.length && type !== 'dir'
      const prior = paths.get(key)
      if (prior && (prior.spelling !== spelling || file || prior.file)) add('path-duplicate', path)
      paths.set(key, { spelling, file })
    }
    if ((type !== undefined && !['file', 'dir'].includes(type)) || (type !== 'dir' && !(bytes instanceof Uint8Array))) {
      add('not-regular', path)
    }
    const size = bytes?.byteLength ?? 0
    if (size > LIMITS.file) add('file-large', path)
    if (path === 'SKILL.md' && size > LIMITS.skillMd) add('skill-md-large', path)
    total += size
  }
  if (total > LIMITS.total) add('total-large', 'SKILL.md')
  const md = bytesFiles.find(entry => entry.path === 'SKILL.md')
  if (!md) add('skill-md-missing', 'SKILL.md')
  if (counts.block === 0) {
    const parsed = parseSkillMd(md.bytes)
    if (!parsed.ok) add('frontmatter-invalid', md.path)
    else {
      const { name, description, fields } = parsed
      if (!skillName(name)) add('name-invalid', md.path)
      else if (expectedName !== undefined && name !== expectedName) add('name-mismatch', md.path)
      if (typeof name === 'string' && skillName(name)) frontmatter.name = name
      if (typeof description !== 'string' || !description.trim()) add('description-missing', md.path, null, undefined, legacy ? 'warn' : 'block')
      else if (description.length > LIMITS.description) add('description-long', md.path)
      else frontmatter.description = description
      for (const key of Object.keys(fields)) if (GRANTS.has(key)) add('run-or-grant', md.path, null, key)
      const declared = fields['allowed-tools']
      const names = Array.isArray(declared) ? declared : typeof declared === 'string' ? declared.split(/[\s,]+/) : []
      for (const name of names) if (/^[\w.-]{1,100}$/.test(name) && uses.tools.size < 50) uses.tools.add(name)
    }
    const unusual = new Set()
    for (const entry of bytesFiles) scanFile(entry, add, uses, unusual)
  }
  return {
    version: SKILL_CHECK_VERSION, fingerprint: SKILL_CHECK_FINGERPRINT, hash,
    verdict: counts.block ? 'block' : counts.warn ? 'warn' : 'pass',
    findings: findings.sort(digestOrder), injection, truncated, counts,
    uses: { tools: [...uses.tools].sort(byteOrder), scripts: uses.scripts, endpoints: [...uses.endpoints].sort(byteOrder), secrets: [...uses.secrets].sort(byteOrder) },
    frontmatter, legacy,
  }
}
