import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, join } from 'node:path'
import { AUTOMATIC_SKILL_MODE, DEFAULT_SKILL_MODE, isSkillMode } from '../shared/skill-mode.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { replaceFile } from './files.js'
import { checkSkill, parseSkillMd, SKILL_CHECK_FINGERPRINT } from './skill-check.js'
import { LIMITS, skillName, textSkillMd } from './skill-library-rules.js'

const SKILL_READS = new Set(['skill-library', 'skill-library-get'])
const SKILL_WRITES = new Set(['skill-library-save', 'skill-library-delete', 'bot-skill-add', 'bot-skill-remove', 'bot-skill-mode'])
export const isSkillEndpoint = endpoint => SKILL_READS.has(endpoint) || SKILL_WRITES.has(endpoint)
export const SKILL_PERSON_ONLY = "Only the person adds or removes a Bot's skills, on the Skills screen and in Details."
const FILE_FORMAT = 'Choose a .md, .markdown or .txt file in UTF-8.'
const TOO_LARGE = 'The skill is over 64 KiB. Shorten it.'
const DESCRIPTION = 'Write a one-line description of up to 200 characters.'
const CHANGED = 'Its stored files are missing or changed; save the skill again.'
const CONFIRM = 'Review the warnings, then save again to confirm.'
const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const reject = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const notWritable = () => reject('This host can only read the team.', 'bot/read-only')
const owner = caller => caller?.role === 'owner' || caller?.role === 'admin'
const findingView = ({ rule, level, reason, line }) => ({ rule, level, reason, line })
function checkOf(name, bytes, parsed) {
  const scan = file => checkSkill([{ path: 'SKILL.md', bytes: file }], { expectedName: name })
  const raw = scan(bytes)
  if (raw.verdict === 'block' || !parsed.ok || typeof parsed.description !== 'string') return raw
  // A file can encode a character in its frontmatter that is literal in the catalog.
  const delivered = textSkillMd({ name, description: parsed.description, content: parsed.body })
  if (bytes.equals(delivered)) return raw
  const check = scan(delivered)
  if (check.verdict === 'pass') return raw
  const verdict = check.verdict === 'block' ? 'block' : 'warn'
  const findings = [...raw.findings, ...check.findings].filter((finding, index, all) =>
    all.findIndex(other => other.rule === finding.rule && other.line === finding.line) === index)
  return { ...raw, verdict, findings }
}
const validDescription = value => typeof value === 'string' && value.trim() !== '' &&
  value.length <= 200 && !/[\r\n\u0085\u2028\u2029]/u.test(value)
const wellFormed = value => typeof value === 'string' && Buffer.from(value).toString('utf8') === value
const fromUtf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const sourceFile = name => typeof name === 'string' && name.length <= 255 && basename(name) === name &&
  !/[\\\p{Cc}\p{Cf}]/u.test(name) && /\.(?:md|markdown|txt)$/i.test(name)

function assignments(list, skills) {
  const active = new Map()
  if (!Array.isArray(list)) return active
  for (const item of list) {
    const name = typeof item === 'string' ? item : item?.name
    if (!skills.has(name)) continue
    const mode = item?.mode === AUTOMATIC_SKILL_MODE && !active.has(name)
      ? AUTOMATIC_SKILL_MODE : DEFAULT_SKILL_MODE
    active.set(name, mode)
  }
  return active
}

const asList = active => [...active].map(([name, mode]) => ({ name, mode }))

function documentOf(name, body) {
  if (![undefined, 'text', 'file'].includes(body.source)) throw reject(FILE_FORMAT)
  if (body.source === 'file' && body.fileBytes === undefined && body.edit !== true) throw reject(FILE_FORMAT)
  if (!validDescription(body.description)) throw reject(DESCRIPTION)
  let content = body.content
  if (body.source === 'file' && body.fileBytes !== undefined) {
    if (!sourceFile(body.fileName) || typeof body.fileBytes !== 'string') throw reject(FILE_FORMAT)
    if (body.fileBytes.length > Math.ceil(LIMITS.skillMd / 3) * 4) throw reject(TOO_LARGE)
    const raw = Buffer.from(body.fileBytes, 'base64')
    if (raw.length > LIMITS.skillMd) throw reject(TOO_LARGE)
    if (raw.toString('base64') !== body.fileBytes) throw reject(FILE_FORMAT)
    try { content = fromUtf8(raw) } catch { throw reject(FILE_FORMAT) }
    if (/^\ufeff?---\r?(?:\n|$)/.test(content)) return { bytes: raw, frontmatter: content }
  }
  if (typeof content === 'string' && Buffer.byteLength(content) > LIMITS.skillMd) throw reject(TOO_LARGE)
  if (!wellFormed(content)) throw reject(FILE_FORMAT)
  return { bytes: textSkillMd({ name, description: body.description, content }) }
}

function checkFailure(check) {
  const first = check.findings.find(finding => finding.level === 'block')
  const reason = first?.reason ?? 'The deterministic check blocked this skill.'
  const line = first?.line ?? 1
  const help = first?.rule.startsWith('secret-') || first?.rule === 'endpoint-credential'
    ? 'Name the key in the skill and set its value in Apps or Secrets.' : 'Change the text and save again.'
  return Object.assign(reject(`Not saved: ${reason} (line ${line}). ${help}`), { auditReason: `${first?.rule ?? 'blocked'} line ${line}` })
}

function checkedRecord(name, record, { reviewHeld = false } = {}) {
  const held = reason => ({ name, held: reason })
  if (!record || record.name !== name || reservedCommandOf(name) ||
      !validDescription(record.description) || !wellFormed(record.content) ||
      !['text', 'file'].includes(record.source?.kind)) return held(CHANGED)
  if (record.source.kind === 'file' && !sourceFile(record.source.fileName)) return held(CHANGED)
  const bytes = record.frontmatter === undefined ? textSkillMd(record)
    : record.source.kind === 'file' && wellFormed(record.frontmatter) ? Buffer.from(record.frontmatter) : undefined
  if (!bytes || bytes.length > LIMITS.skillMd) return held(CHANGED)
  const parsed = parseSkillMd(bytes)
  const check = checkOf(name, bytes, parsed)
  if (check.verdict === 'block') return held(checkFailure(check).message)
  if (!parsed.ok || parsed.name !== name || parsed.description !== record.description || parsed.body !== record.content ||
      check.hash !== record.hash) return held(CHANGED)
  const needsReview = check.verdict === 'warn' && (record.accepted !== check.hash ||
      record.check?.fingerprint !== SKILL_CHECK_FINGERPRINT)
  if (needsReview && !reviewHeld) return held(CONFIRM)
  const current = record.check?.version === check.version && record.check?.fingerprint === check.fingerprint
  return {
    name, description: parsed.description, content: parsed.body, hash: check.hash,
    source: record.source.kind === 'file' ? { kind: 'file', fileName: record.source.fileName } : { kind: 'text' },
    check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict,
      ranAt: current && Number.isFinite(record.check?.ranAt) ? record.check.ranAt : Date.now(),
      findings: check.findings.map(findingView) },
    ...(needsReview ? { held: CONFIRM } : {}),
  }
}

const stat = path => fs.lstatSync(path, { throwIfNoEntry: false })
const owned = info => process.getuid === undefined || info.uid === process.getuid()
const privateMode = info => process.platform === 'win32' || !(info.mode & 0o077)
const safeFile = info => info?.isFile() && info.nlink === 1 && privateMode(info) && owned(info)
const safeDir = info => info?.isDirectory() && privateMode(info) && owned(info)
const sameInode = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const fileStamp = info => info && [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')

export function install(rt) {
  const root = join(rt.home, 'skill-library')
  const path = join(root, 'library.json')
  const auditPath = join(root, 'audit.jsonl')
  const confirmationKey = randomBytes(32)
  let queue = Promise.resolve()
  let cache
  const botRemovals = new Map()
  const serial = task => {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  function directory(create = false) {
    if (create) {
      try { fs.mkdirSync(root, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    const info = stat(root)
    if (info && !safeDir(info)) throw reject('The Skills library folder is unavailable.', 'bot/refused')
    return info
  }

  function snapshot(fresh = false) {
    const rootInfo = directory()
    const info = rootInfo && stat(path)
    const stamp = fileStamp(info)
    const generation = JSON.stringify(rt.teamGeneration())
    if (!fresh && cache && cache.stamp === stamp && cache.generation === generation) return cache
    let data = { version: 1, skills: {}, active: {} }
    if (info) {
      if (!safeFile(info)) throw reject('The Skills library file is unavailable.', 'bot/refused')
      const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      try {
        const opened = fs.fstatSync(fd)
        if (!safeFile(opened) || fileStamp(opened) !== stamp) throw notWritable()
        try { data = JSON.parse(fromUtf8(fs.readFileSync(fd))) } catch {
          throw reject('The Skills library file is unavailable.', 'bot/refused')
        }
        if (fileStamp(fs.fstatSync(fd)) !== stamp || !sameInode(rootInfo, directory())) throw notWritable()
      } finally { fs.closeSync(fd) }
      if (data?.version !== 1 || !data.skills || Array.isArray(data.skills) || typeof data.skills !== 'object'
          || !data.active || Array.isArray(data.active) || typeof data.active !== 'object') {
        throw reject('The Skills library file is unavailable.', 'bot/refused')
      }
    }
    const skills = new Map(Object.entries(data.skills).filter(([name]) => skillName(name))
      .map(([name, record]) => [name, checkedRecord(name, record)]))
    cache = { data, stamp, generation, skills }
    return cache
  }

  function audit(action, body, caller, outcome, reason) {
    try {
      const { name, id } = body ?? {}
      const rootInfo = directory(true)
      const fd = fs.openSync(auditPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND |
        (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600)
      try {
        if (!safeFile(fs.fstatSync(fd)) || !sameInode(rootInfo, directory())) return
        const target = skillName(name) ? name : typeof id === 'string' && rt.botOf(id) ? id : null
        fs.writeFileSync(fd, JSON.stringify({ time: Date.now(), action, target, caller, outcome, reason }) + '\n')
      } finally { fs.closeSync(fd) }
    } catch { rt.warn?.('Skills audit could not be written') }
  }

  async function write(data, generation, before) {
    const assertOwner = () => {
      if (rt.readOnly() !== undefined || !rt.sameTeam(generation) || rt.teamCurrent?.() === false) throw notWritable()
    }
    assertOwner()
    const rootInfo = directory(true)
    const verify = () => {
      assertOwner()
      if (!sameInode(rootInfo, directory()) || fileStamp(stat(path)) !== before) throw notWritable()
    }
    const temp = join(root, `library-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      verify()
      await replaceFile(temp, path, verify, { rename: fs.renameSync })
    } finally {
      if (sameInode(rootInfo, directory())) fs.rmSync(temp, { force: true })
      cache = undefined
    }
  }

  function warningReceipt(hash, identity, generation) {
    return createHmac('sha256', confirmationKey)
      .update(JSON.stringify([identity, generation, hash, SKILL_CHECK_FINGERPRINT])).digest('hex')
  }

  function save(data, body, identity, generation) {
    const { name } = body
    if (!skillName(name)) throw reject('Use lowercase letters, digits and single hyphens, up to 32 characters, starting with a letter.')
    if (reservedCommandOf(name)) throw reject(`The name ${name} is reserved for the /${name} command. Choose another name.`)
    const previous = own(data.skills, name)
    if (previous && body.edit !== true) throw reject(`A skill named ${name} already exists. Edit it, or choose another name.`)
    if (!previous && body.edit === true) throw reject('Unknown skill', 'bot/not-found')
    if (body.reviewHash !== undefined) {
      const review = checkedRecord(name, previous, { reviewHeld: true })
      if (review.held !== CONFIRM || review.hash !== body.reviewHash) {
        throw reject(CHANGED, 'bot/refused')
      }
      const needsConfirm = warningReceipt(review.hash, identity, generation)
      if (body.confirm !== needsConfirm) return { needsConfirm, findings: review.check.findings }
      // The checked document may contain imported frontmatter and formatting.
      // Refresh only its acceptance so the exact stored bytes survive.
      const now = Date.now()
      data.skills[name] = { ...previous, updatedAt: now, accepted: review.hash,
        check: { ...review.check, ranAt: now } }
      return { saved: true }
    }
    const { bytes, frontmatter } = documentOf(name, body)
    if (bytes.length > LIMITS.skillMd) throw reject(TOO_LARGE)
    const parsed = parseSkillMd(bytes)
    const check = checkOf(name, bytes, parsed)
    if (check.verdict === 'block') throw checkFailure(check)
    if (!validDescription(parsed.description)) throw reject(DESCRIPTION)
    const findings = check.findings.map(findingView)
    const needsConfirm = warningReceipt(check.hash, identity, generation)
    if (check.verdict === 'warn' && body.confirm !== needsConfirm) return { needsConfirm, findings }
    const now = Date.now()
    let source = { kind: 'text' }
    if (body.source === 'file') {
      if (!sourceFile(body.fileName)) throw reject(FILE_FORMAT)
      source = { kind: 'file', fileName: body.fileName }
    }
    data.skills[name] = {
      name, description: parsed.description, content: parsed.body, source, createdAt: previous?.createdAt ?? now,
      updatedAt: now, hash: check.hash,
      check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict, ranAt: now, findings },
      ...(frontmatter === undefined ? {} : { frontmatter }),
      ...(check.verdict === 'warn' ? { accepted: check.hash } : {}),
    }
    return { saved: true }
  }

  function active(botId) {
    if (typeof botId !== 'string' || !rt.botOf(botId) || rt.teamCurrent?.() === false) return []
    try {
      const { data, skills } = snapshot()
      return asList(assignments(own(data.active, botId), skills))
        .filter(({ name }) => !skills.get(name).held)
        .map(({ name, mode }) => ({ ...skills.get(name), mode }))
    } catch { return [] }
  }

  function authorizedGeneration(generation) {
    if (rt.readOnly() !== undefined || !rt.sameTeam(generation) || rt.teamCurrent?.() === false) throw notWritable()
  }

  async function endpoint(action, body = {}, caller) {
    const generation = rt.teamGeneration()
    const identity = owner(caller) ? caller.id ?? caller.role : 'untrusted'
    if (!owner(caller)) {
      await serial(() => audit(action, body, identity, 'refused', 'owner-only'))
      throw reject(SKILL_PERSON_ONLY, 'bot/refused')
    }
    if (SKILL_READS.has(action)) {
      const { data, skills } = snapshot(true)
      if (action === 'skill-library-get') {
        const record = skills.get(body.name)
        if (!record) throw reject('Unknown skill', 'bot/not-found')
        if (record.held === CONFIRM) return checkedRecord(body.name, own(data.skills, body.name), { reviewHeld: true })
        return record
      }
      const active = Object.fromEntries(Object.entries(data.active)
        .filter(([id, names]) => rt.botOf(id) && Array.isArray(names))
        .map(([id, list]) => [id, asList(assignments(list, skills))]))
      return { skills: [...skills.values()].map(({ content, ...record }) => record), active }
    }

    return serial(async () => {
      try {
        authorizedGeneration(generation)
        const { data: current, stamp, skills } = snapshot(true)
        const data = structuredClone(current)
        const { id, name } = body
        let result = { saved: true }
        if (action === 'skill-library-save') result = save(data, body, identity, generation)
        else if (action === 'skill-library-delete') {
          if (!skills.has(name)) throw reject('Unknown skill', 'bot/not-found')
          delete data.skills[name]
          for (const [key, list] of Object.entries(data.active)) {
            const active = assignments(list, skills)
            if (active.delete(name)) data.active[key] = asList(active)
          }
        } else if (action === 'bot-skill-add' || action === 'bot-skill-remove' || action === 'bot-skill-mode') {
          if (typeof id !== 'string' || !rt.botOf(id) || !skills.has(name)) throw reject('Unknown Bot or skill', 'bot/not-found')
          const active = assignments(own(data.active, id), skills)
          const editing = action === 'bot-skill-mode'
          if (editing && !active.has(name)) throw reject('This skill is not active on this Bot.', 'bot/not-found')
          if (action === 'bot-skill-remove') active.delete(name)
          else {
            const mode = body.mode === undefined && !editing ? DEFAULT_SKILL_MODE : body.mode
            if (!isSkillMode(mode)) throw reject('Choose a skill mode.')
            const record = skills.get(name)
            if (record.held) throw reject(`${name} is held: ${record.held} Open it on the Skills screen and save it again.`)
            const prior = active.get(name)
            if (prior === undefined || editing) active.set(name, mode)
            const automatic = [...active].filter(([skill, use]) => use === AUTOMATIC_SKILL_MODE && !skills.get(skill).held)
            if (prior !== AUTOMATIC_SKILL_MODE && active.get(name) === AUTOMATIC_SKILL_MODE && automatic.length >= 5) {
              result.warning = 'Many active skills use more of the model’s context.'
            }
          }
          Object.defineProperty(data.active, id, { value: asList(active), enumerable: true, configurable: true, writable: true })
        } else throw reject('Unknown Skills action')
        if (!result.needsConfirm) await write(data, generation, stamp)
        audit(action, body, identity, result.needsConfirm ? 'pending' : 'allowed', result.needsConfirm ? 'confirmation' : null)
        return result
      } catch (error) {
        audit(action, body, identity, 'refused', error.auditReason ?? error.code ?? 'error')
        throw error
      }
    })
  }

  async function clearOrphan(id, generation) {
    if (rt.botOf(id)) return
    const { data, stamp } = snapshot(true)
    if (own(data.active, id) === undefined) return
    const next = structuredClone(data)
    delete next.active[id]
    await write(next, generation, stamp)
  }

  function duringBotDeletion(id, remove) {
    const generation = rt.teamGeneration()
    const earlier = botRemovals.get(id) ?? Promise.resolve()
    // Roster work can wait for ownership teardown, which itself waits for
    // the library write queue. Only the committed cleanup joins that queue.
    const run = earlier.catch(() => {}).then(remove).then(async result => {
      // The roster has committed the removal. A failure before that point
      // leaves the assignments in place for the restored Bot.
      try { await serial(() => clearOrphan(id, generation)) } catch (error) {
        rt.warn?.('Skills assignments for the removed Bot could not be cleared: %s', error)
      }
      return result
    })
    botRemovals.set(id, run)
    return run.finally(() => {
      if (botRemovals.get(id) === run) botRemovals.delete(id)
    })
  }

  rt.holdLockUntil?.(() => queue)
  rt.skillLibrary = {
    endpoint, active, duringBotDeletion,
    async clearOrphan(id) {
      const generation = rt.teamGeneration()
      await botRemovals.get(id)?.catch(() => {})
      return serial(() => clearOrphan(id, generation))
    },
    refuse(action, body, caller) {
      return serial(() => audit(action, body, caller, 'refused', 'owner-only'))
    },
  }
}
