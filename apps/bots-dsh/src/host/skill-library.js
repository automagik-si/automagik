import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { basename, join } from 'node:path'
import { AUTOMATIC_SKILL_MODE, DEFAULT_SKILL_MODE, isSkillMode } from '../shared/skill-mode.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { replaceFile, syncDirectory, syncFile } from './files.js'
import { checkSkill, parseSkillMd, SKILL_CHECK_FINGERPRINT } from './skill-check.js'
import { SKILL_CHECK_HISTORY } from './skill-check-version.js'
import { LIMITS, skillHash, skillName, textSkillMd } from './skill-library-rules.js'
import { runSkillReview } from './skill-review.js'
import { writeBytesAtomic } from './supervisor/store.js'

const SKILL_READS = new Set(['skill-library', 'skill-library-get'])
const SKILL_WRITES = new Set(['skill-library-save', 'skill-library-delete', 'bot-skill-add', 'bot-skill-remove', 'bot-skill-mode'])
export const isSkillEndpoint = endpoint => SKILL_READS.has(endpoint) || SKILL_WRITES.has(endpoint)
export const SKILL_PERSON_ONLY = "Only the person adds or removes a Bot's skills, on the Skills screen and in Details."
const FILE_FORMAT = 'Choose a .md, .markdown or .txt file in UTF-8.'
const TOO_LARGE = 'The skill is over 64 KiB. Shorten it.'
const DESCRIPTION = 'Write a one-line description of up to 200 characters.'
const CHANGED = 'Its stored files are missing or changed; save the skill again.'
const CONFIRM = 'Review the warnings, then save again to confirm.'
const NO_MODEL = 'Not saved: every skill needs a model review, and no background model is available. Choose one in Settings, Background model, then try again.'
const REVIEW_FAILED = 'Not saved: the model review did not finish, and every skill needs one. Try again.'
const INJECTION = 'Not saved: prompt injection was found. A skill with prompt injection is never accepted.'
const HELD_INJECTION = 'Held: prompt injection was found. A skill with prompt injection is never accepted.'
const REVIEW_NEEDED = 'A model has not reviewed this skill yet. Review the stored skill to continue.'
const INCOMPLETE = 'Not saved: the security report is incomplete. Change the skill and try again.'
const REVIEW_BUSY = 'Another skill review is running. Try again.'
const HOLD_PREEXISTING_TYPED = true
export const SKILL_REVIEW_KEY = 'skill-review.key'
export const SKILL_IMPORT_MARK = 'skill-library-imported'
const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const reject = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const notWritable = () => reject('This host can only read the team.', 'bot/read-only')
const owner = caller => caller?.role === 'owner' || caller?.role === 'admin'
const findingView = ({ rule, level, reason, line, path, area }) =>
  ({ rule, level, reason, line, path, area, injection: area === 'prompt-injection' })
const modelFindingView = finding => ({ ...finding, injection: finding.area === 'prompt-injection' })
const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const equalMac = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
const findingKey = finding => JSON.stringify([finding.rule, finding.path, finding.line])
const uniqueFindings = findings => [...new Map(findings.map(finding => [findingKey(finding), finding])).values()]
const checkFindings = check => uniqueFindings([...check.findings, ...check.injection]).map(findingView)

export function mergeSkillChecks(raw, delivered) {
  return { ...raw, verdict: [raw.verdict, delivered.verdict].includes('block') ? 'block'
    : [raw.verdict, delivered.verdict].includes('warn') ? 'warn' : 'pass',
  findings: uniqueFindings([...raw.findings, ...delivered.findings]),
  injection: uniqueFindings([...raw.injection, ...delivered.injection]),
  truncated: raw.truncated || delivered.truncated,
  counts: { block: raw.counts.block + delivered.counts.block, warn: raw.counts.warn + delivered.counts.warn } }
}

function checkOf(name, bytes, parsed) {
  const scan = file => checkSkill([{ path: 'SKILL.md', bytes: file }], { expectedName: name })
  const raw = scan(bytes)
  if (!parsed.ok || typeof parsed.description !== 'string') return raw
  // A file can encode a character in its frontmatter that is literal in the catalog.
  const delivered = textSkillMd({ name, description: parsed.description, content: parsed.body })
  if (bytes.equals(delivered)) return raw
  return mergeSkillChecks(raw, scan(delivered))
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

function storedDocument(name, record) {
  if (!record || record.name !== name || reservedCommandOf(name) ||
      !validDescription(record.description) || !wellFormed(record.content) ||
      !['text', 'file'].includes(record.source?.kind)) return
  if (record.source.kind === 'file' && !sourceFile(record.source.fileName)) return
  const bytes = record.frontmatter === undefined ? textSkillMd(record)
    : record.source.kind === 'file' && wellFormed(record.frontmatter) ? Buffer.from(record.frontmatter) : undefined
  if (!bytes || bytes.length > LIMITS.skillMd) return
  const parsed = parseSkillMd(bytes)
  const check = checkOf(name, bytes, parsed)
  const valid = parsed.ok && parsed.name === name && parsed.description === record.description &&
    parsed.body === record.content && check.hash === record.hash
  return { bytes, parsed, check, valid }
}

const stat = path => fs.lstatSync(path, { throwIfNoEntry: false })
const owned = info => process.getuid === undefined || info.uid === process.getuid()
const privateMode = info => process.platform === 'win32' || !(info.mode & 0o077)
const safeFile = info => info?.isFile() && info.nlink === 1 && privateMode(info) && owned(info)
const safeDir = info => info?.isDirectory() && privateMode(info) && owned(info)
const sameInode = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const fileStamp = info => info && [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')

export function install(rt, { holdPreexistingTyped = HOLD_PREEXISTING_TYPED } = {}) {
  const root = join(rt.home, 'skill-library')
  const path = join(root, 'library.json')
  const auditPath = join(root, 'audit.jsonl')
  const keyPath = join(rt.home, SKILL_REVIEW_KEY)
  const importMark = join(rt.home, SKILL_IMPORT_MARK)
  const confirmationKey = randomBytes(32)
  let queue = Promise.resolve()
  let cache
  const botRemovals = new Map()
  const saves = new Map()
  let reviewing
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

  function hostKey(create = false) {
    if (create && !stat(keyPath)) {
      try { writeBytesAtomic(keyPath, randomBytes(32), { exclusive: true, durable: true }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    let fd
    try {
      fd = fs.openSync(keyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    try {
      const info = fs.fstatSync(fd)
      if (!safeFile(info) || info.size !== 32) throw notWritable()
      return fs.readFileSync(fd)
    } finally { fs.closeSync(fd) }
  }

  const mac = (key, ...value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
  const attestation = (key, review) => mac(key, 'review-v1', hashJson(review))
  const acceptance = (key, record, fingerprint, digest) =>
    mac(key, 'accept-v1', record.name, record.source, record.hash, fingerprint, digest)
  const verifies = (key, hash, review, seal) => key && review?.status === 'done' && review.hash === hash &&
    Array.isArray(review.findings) && equalMac(seal, attestation(key, review))
  const cachedReview = (data, hash, key) => {
    const entry = own(data.reviews, hash)
    if (verifies(key, hash, entry?.review, entry?.seal)) return entry.review
  }
  const blockFor = (data, hash, key) => {
    const entry = own(data.reviewBlocks, hash)
    if (key && Array.isArray(entry?.findings) &&
        equalMac(entry.seal, mac(key, 'injection-v1', hash, hashJson(entry.findings)))) return entry.findings
  }

  function checkedRecord(name, record, data, key, legacyLocal) {
    const document = storedDocument(name, record)
    if (!document) return { name, held: CHANGED }
    const { check, parsed, valid } = document
    if (check.injection.length || blockFor(data, check.hash, key)) return { name, held: HELD_INJECTION }
    if (check.verdict === 'block') return { name, held: checkFailure(check).message }
    if (!valid) return { name, held: CHANGED }
    const review = verifies(key, check.hash, record.review, record.reviewSeal) ? record.review : undefined
    if (review?.findings.some(finding => finding.area === 'prompt-injection')) return { name, held: HELD_INJECTION }
    const legacy = legacyLocal && record.source.kind === 'text' && record.review === undefined &&
      record.reviewSeal === undefined && SKILL_CHECK_HISTORY[record.check?.version] === record.check?.fingerprint &&
      record.check?.fingerprint !== undefined && record.check.fingerprint !== SKILL_CHECK_FINGERPRINT &&
      check.verdict === 'pass'
    const digest = review && hashJson(review)
    const needsConfirm = review && (check.verdict === 'warn' || review.findings.length) &&
      (record.accepted !== check.hash || record.acceptedReview !== digest ||
        !equalMac(record.acceptanceSeal, acceptance(key, record, check.fingerprint, digest)))
    const held = check.truncated ? INCOMPLETE : !review && (holdPreexistingTyped || !legacy) ? REVIEW_NEEDED
      : needsConfirm ? CONFIRM : undefined
    const current = record.check?.version === check.version && record.check?.fingerprint === check.fingerprint
    const source = record.source.kind === 'file' ? { kind: 'file', fileName: record.source.fileName } : { kind: 'text' }
    return { name, description: parsed.description, content: parsed.body, hash: check.hash, source,
      check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict,
        ranAt: current && Number.isFinite(record.check?.ranAt) ? record.check.ranAt : Date.now(),
        findings: checkFindings(check), truncated: check.truncated, counts: check.counts },
      ...(review ? { review } : {}), ...(held ? { held } : {}),
      ...(held === REVIEW_NEEDED || held === CONFIRM ? { reviewHash: check.hash } : {}) }
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
    const key = hostKey()
    const legacyLocal = !stat(importMark)
    const skills = new Map(Object.entries(data.skills).filter(([name]) => skillName(name))
      .map(([name, record]) => [name, checkedRecord(name, record, data, key, legacyLocal)]))
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

  async function write(data, generation, before, durable = false) {
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
      if (durable) await syncFile(temp)
      verify()
      await replaceFile(temp, path, verify, { rename: fs.renameSync })
      if (durable) await syncDirectory(root)
    } finally {
      if (sameInode(rootInfo, directory())) fs.rmSync(temp, { force: true })
      cache = undefined
    }
  }

  function reviewReceipt(check, reviewDigest, identity, generation) {
    return mac(confirmationKey, 'confirm-v1', identity, generation, check.hash, check.fingerprint, reviewDigest)
  }

  function decisionOf(check, review, blocked, identity, generation) {
    const gateFindings = checkFindings(check)
    const modelFindings = [...new Map([...(review?.findings ?? []), ...(blocked ?? [])]
      .map(finding => [JSON.stringify(finding), finding])).values()]
    const findings = [...gateFindings, ...modelFindings.map(modelFindingView)]
    const reviewDigest = review?.status === 'done' ? hashJson(review) : null
    const out = { findings, review, reviewDigest, truncated: check.truncated || review?.why === 'overflow', counts: check.counts }
    if (check.injection.length || blocked || modelFindings.some(finding => finding.area === 'prompt-injection')) {
      return { ...out, decision: 'refuse', why: 'injection', message: INJECTION }
    }
    if (check.verdict === 'block') return { ...out, decision: 'block', message: checkFailure(check).message }
    if (check.truncated) return { ...out, decision: 'refuse', why: 'incomplete', message: INCOMPLETE }
    if (review?.status === 'none') return { ...out, decision: 'refuse', why: 'no-model', message: NO_MODEL }
    if (review?.status !== 'done') return { ...out, decision: 'refuse', why: 'review-failed', message: REVIEW_FAILED }
    if (!findings.length) return { ...out, decision: 'accept' }
    return { ...out, decision: 'confirm', receipt: reviewReceipt(check, reviewDigest, identity, generation) }
  }

  async function reviewSkill({ name, entries, check, caller }) {
    const { identity, generation } = caller
    const ensureCurrent = () => authorizedGeneration(generation)
    ensureCurrent()
    const ownedEntries = entries.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }))
    if (skillHash(ownedEntries) !== check.hash) throw reject(CHANGED, 'bot/refused')
    const { data } = snapshot(true)
    const key = hostKey()
    const blocked = blockFor(data, check.hash, key)
    const known = cachedReview(data, check.hash, key)
    const prior = decisionOf(check, known, blocked, identity, generation)
    if (blocked || known || check.injection.length || check.verdict === 'block' || check.truncated) return prior

    const generationKey = JSON.stringify(generation)
    if (reviewing && (reviewing.hash !== check.hash || reviewing.generationKey !== generationKey)) {
      return { ...prior, why: 'busy', message: REVIEW_BUSY }
    }
    if (!reviewing) {
      const entry = { hash: check.hash, generationKey }
      reviewing = entry
      entry.result = (async () => {
        // Establish that the team can persist a decision before its provider is contacted.
        const signingKey = await serial(() => { ensureCurrent(); return hostKey(true) })
        const block = findings => serial(async () => {
          ensureCurrent()
          const { data, stamp } = snapshot(true)
          const previous = blockFor(data, check.hash, signingKey) ?? []
          const all = [...new Map([...previous, ...findings].map(finding => [JSON.stringify(finding), finding])).values()]
          const seal = mac(signingKey, 'injection-v1', check.hash, hashJson(all))
          await write({ ...data, reviewBlocks: { ...data.reviewBlocks, [check.hash]: { findings: all, seal } } },
            generation, stamp, true)
        })
        const result = await runSkillReview(rt, { name, entries: ownedEntries, hash: check.hash }, { check: ensureCurrent, block })
        if (result.status === 'done') {
          await serial(async () => {
            ensureCurrent()
            const { data, stamp } = snapshot(true)
            const reviews = { ...data.reviews, [check.hash]: { review: result, seal: attestation(signingKey, result) } }
            const retained = new Set(Object.values(data.skills).map(record => record?.hash))
            const recent = Object.keys(reviews).filter(hash => !retained.has(hash) && hash !== check.hash)
              .sort((a, b) => (reviews[b]?.review?.at ?? 0) - (reviews[a]?.review?.at ?? 0))
            for (const hash of recent.slice(retained.has(check.hash) ? 50 : 49)) delete reviews[hash]
            await write({ ...data, reviews }, generation, stamp)
          })
        }
        return result
      })().finally(() => { if (reviewing === entry) reviewing = undefined })
    }
    const result = await reviewing.result
    ensureCurrent()
    const current = snapshot(true)
    return decisionOf(check, result, blockFor(current.data, check.hash, hostKey()), identity, generation)
  }

  function prepareSave(data, body) {
    const { name } = body
    if (!skillName(name)) throw reject('Use lowercase letters, digits and single hyphens, up to 32 characters, starting with a letter.')
    if (reservedCommandOf(name)) throw reject(`The name ${name} is reserved for the /${name} command. Choose another name.`)
    const previous = own(data.skills, name)
    if (previous && body.edit !== true) throw reject(`A skill named ${name} already exists. Edit it, or choose another name.`)
    if (!previous && body.edit === true) throw reject('Unknown skill', 'bot/not-found')
    if (body.reviewHash !== undefined) {
      const document = storedDocument(name, previous)
      if (!document?.valid || document.check.hash !== body.reviewHash) throw reject(CHANGED, 'bot/refused')
      const record = checkedRecord(name, previous, data, hostKey(), !stat(importMark))
      if (!record.reviewHash && !record.held) throw reject(CHANGED, 'bot/refused')
      return { ...document, previous, source: previous.source, frontmatter: previous.frontmatter }
    }
    const { bytes, frontmatter } = documentOf(name, body)
    if (bytes.length > LIMITS.skillMd) throw reject(TOO_LARGE)
    const parsed = parseSkillMd(bytes)
    const check = checkOf(name, bytes, parsed)
    if (check.verdict !== 'block' && !validDescription(parsed.description)) throw reject(DESCRIPTION)
    let source = previous?.source ?? { kind: 'text' }
    if (body.source === 'file' && (body.fileBytes !== undefined || previous?.source.kind !== 'file')) {
      if (!sourceFile(body.fileName)) throw reject(FILE_FORMAT)
      source = { kind: 'file', fileName: body.fileName }
    }
    return { bytes, parsed, check, previous, source, frontmatter }
  }

  function saveView(decision) {
    const { findings, review, truncated, counts } = decision
    if (decision.decision === 'confirm') return { needsConfirm: decision.receipt, findings, review, truncated, counts }
    return { refused: true, message: decision.message, findings, review, truncated, counts }
  }

  async function save(body, identity, generation) {
    const action = 'skill-library-save'
    try {
      authorizedGeneration(generation)
      const { name } = body
      const first = prepareSave(snapshot(true).data, body)
      const reviewed = await reviewSkill({ name, entries: [{ path: 'SKILL.md', bytes: first.bytes }],
        check: first.check, source: first.source.kind, caller: { identity, generation } })
      if (reviewed.decision === 'block' || reviewed.decision === 'refuse') {
        authorizedGeneration(generation)
        const reason = reviewed.why === 'review-failed' && reviewed.review?.why
          ? `review-failed:${reviewed.review.why}` : reviewed.why ?? 'deterministic'
        audit(action, body, identity, 'refused', reason)
        return saveView(reviewed)
      }

      return await serial(async () => {
        authorizedGeneration(generation)
        const { data, stamp } = snapshot(true)
        if (JSON.stringify(own(data.skills, name)) !== JSON.stringify(first.previous)) throw reject(CHANGED, 'bot/refused')
        const { previous, bytes, parsed, check, source, frontmatter } = prepareSave(data, body)
        if (!bytes.equals(first.bytes) || check.hash !== first.check.hash) throw reject(CHANGED, 'bot/refused')
        const key = hostKey()
        const decision = decisionOf(check, cachedReview(data, check.hash, key), blockFor(data, check.hash, key), identity, generation)
        if (decision.reviewDigest !== reviewed.reviewDigest) throw reject(CHANGED, 'bot/refused')
        if (decision.decision !== 'accept' && (decision.decision !== 'confirm' || !equalMac(body.confirm, decision.receipt))) {
          audit(action, body, identity, decision.decision === 'confirm' ? 'pending' : 'refused', decision.why ?? 'confirmation')
          return saveView(decision)
        }
        const now = Date.now()
        const record = {
          name, description: parsed.description, content: parsed.body, source, createdAt: previous?.createdAt ?? now,
          updatedAt: now, hash: check.hash,
          check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict,
            ranAt: now, findings: checkFindings(check) },
          ...(frontmatter === undefined ? {} : { frontmatter }),
          review: decision.review, reviewSeal: attestation(key, decision.review),
        }
        if (decision.decision === 'confirm') {
          record.accepted = check.hash
          record.acceptedReview = decision.reviewDigest
          record.acceptanceSeal = acceptance(key, record, check.fingerprint, decision.reviewDigest)
        }
        await write({ ...data, skills: { ...data.skills, [name]: record } }, generation, stamp)
        audit(action, body, identity, 'allowed', 'review-done')
        return { saved: true }
      })
    } catch (error) {
      if (rt.sameTeam(generation) && rt.teamCurrent?.() !== false) {
        audit(action, body, identity, 'refused', error.auditReason ?? error.code ?? 'error')
      }
      throw error
    }
  }

  // Transport retries use the same operation ID. Polling does not own the
  // review or the write, so disconnecting the initiating request cannot repeat either.
  function saveOperation(body, identity, generation) {
    authorizedGeneration(generation)
    const { operation, poll, ...input } = body
    if (operation === undefined) return save(input, identity, generation)
    if (typeof operation !== 'string' || !/^[a-f0-9]{32}$/.test(operation)) throw reject('Invalid Skills save operation.')
    const scope = JSON.stringify(generation)
    const entry = saves.get(operation)
    if (entry) {
      if (entry.scope !== scope || entry.identity !== identity) {
        throw reject('This Skills save is no longer available. Save the skill again.', 'bot/not-found')
      }
      if (poll !== true && entry.inputHash !== hashJson(input)) throw reject(CHANGED, 'bot/refused')
      if (entry.error) throw entry.error
      return entry.result ?? { pending: true }
    }
    if (poll === true) throw reject('This Skills save is no longer available. Save the skill again.', 'bot/not-found')
    const job = { scope, identity, inputHash: hashJson(input) }
    saves.set(operation, job)
    void save(input, identity, generation).then(result => { job.result = result }, error => { job.error = error })
    return { pending: true }
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
        return record
      }
      const active = Object.fromEntries(Object.entries(data.active)
        .filter(([id, names]) => rt.botOf(id) && Array.isArray(names))
        .map(([id, list]) => [id, asList(assignments(list, skills))]))
      return { skills: [...skills.values()].map(({ content, ...record }) => record), active }
    }

    if (action === 'skill-library-save') return saveOperation(body, identity, generation)

    return serial(async () => {
      try {
        authorizedGeneration(generation)
        const { data: current, stamp, skills } = snapshot(true)
        const data = structuredClone(current)
        const { id, name } = body
        let result = { saved: true }
        if (action === 'skill-library-delete') {
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
    const earlier = botRemovals.get(id)
    const { promise, resolve, reject } = Promise.withResolvers()
    // Roster work can wait for ownership teardown, which itself waits for
    // the library write queue. Only the committed cleanup joins that queue.
    const run = promise.then(async result => {
      // The roster has committed the removal. A failure before that point
      // leaves the assignments in place for the restored Bot.
      try { await serial(() => clearOrphan(id, generation)) } catch (error) {
        rt.warn?.('Skills assignments for the removed Bot could not be cleared: %s', error)
      }
      return result
    })
    botRemovals.set(id, run)
    const start = () => {
      try { resolve(remove()) } catch (error) { reject(error) }
    }
    // Before the caller can update a room, its first deletion must detach the member.
    if (earlier === undefined) start()
    else void earlier.then(start, start)
    return run.finally(() => {
      if (botRemovals.get(id) === run) botRemovals.delete(id)
    })
  }

  rt.holdLockUntil?.(() => queue)
  rt.skillLibrary = {
    endpoint, active, duringBotDeletion, reviewSkill,
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
