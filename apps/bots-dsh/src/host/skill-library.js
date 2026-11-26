import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { basename, join } from 'node:path'
import { compareFiles, findingDelta } from '../shared/skill-diff.js'
import { AUTOMATIC_SKILL_MODE, DEFAULT_SKILL_MODE, isSkillMode } from '../shared/skill-mode.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { hasOnlyHostPublicationLinks, publishHostFile, replaceFile, syncDirectory, syncFile } from './files.js'
import { checkSkill, parseSkillMd, SKILL_CHECK_FINGERPRINT } from './skill-check.js'
import { SKILL_CHECK_HISTORY } from './skill-check-version.js'
import { fileEntries, LIMITS, skillHash, skillName, textSkillMd } from './skill-library-rules.js'
import { runSkillReview } from './skill-review.js'
import { ARCHIVE_BASE64_MAX, ARCHIVE_INPUT_MAX, readSkillArchive, skillArchiveKind } from './skill-archive.js'
import { readSkillFolder } from './skill-folder.js'
import { pathOrder, SKILL_MD, validateSkillTree } from './skill-tree.js'

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
const PREVIEW_BUSY = 'Another skill preview is running. Try again.'
const PREVIEW_EXPIRED = 'This preview expired. Preview the skill again.'
const REPLACE_CHANGED = 'The skill changed since the preview. Preview it again.'
const REPLACE_REQUIRED = 'Replace this skill from a folder or an archive.'
const ARCHIVE_FORMAT = 'Choose a supported .zip or .tar.gz skill archive.'
const ARCHIVE_LARGE = 'The skill archive is over 6 MiB.'
const FOLDER_OWNER = 'Only the owner of this computer can read a folder on it. Upload a .zip or .tar.gz instead.'
const PREVIEW_TTL = 15 * 60 * 1000
const PREVIEW_LIMIT = 4
const HOLD_PREEXISTING_TYPED = true
export const SKILL_REVIEW_KEY = 'skill-review.key'
export const SKILL_IMPORT_MARK = 'skill-library-imported'
const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const reject = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const notWritable = () => reject('This host can only read the team.', 'bot/read-only')
const owner = caller => caller?.role === 'owner' || caller?.role === 'admin'
const findingView = ({ rule, level, reason, line, path, area, detail }) =>
  ({ rule, level, reason, line, path, area, ...(detail === undefined ? {} : { detail }), injection: area === 'prompt-injection' })
const modelFindingView = finding => ({ ...finding, injection: finding.area === 'prompt-injection' })
const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const equalMac = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
const findingKey = finding => JSON.stringify(findingView(finding))
const uniqueFindings = findings => [...new Map(findings.map(finding => [findingKey(finding), finding])).values()]
const checkFindings = check => uniqueFindings([...check.findings, ...check.injection]).map(findingView)
const uniqueModelFindings = findings => [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()]
const reportFindings = (check, model) => [...checkFindings(check), ...uniqueModelFindings(model).map(modelFindingView)]

function treeReportFindings(check, { review, blocked = [] }) {
  // The review preserves occurrences. Durable block evidence adds findings
  // that may be missing from this review, including after an interruption.
  const model = review?.findings ?? []
  const seen = new Set(model.map(finding => JSON.stringify(finding)))
  return [...checkFindings(check), ...model.map(modelFindingView),
    ...blocked.filter(finding => !seen.has(JSON.stringify(finding))).map(modelFindingView)]
}

export function mergeSkillChecks(raw, delivered) {
  return { ...raw, verdict: [raw.verdict, delivered.verdict].includes('block') ? 'block'
    : [raw.verdict, delivered.verdict].includes('warn') ? 'warn' : 'pass',
  findings: uniqueFindings([...raw.findings, ...delivered.findings]),
  injection: uniqueFindings([...raw.injection, ...delivered.injection]),
  truncated: raw.truncated || delivered.truncated,
  counts: { block: raw.counts.block + delivered.counts.block, warn: raw.counts.warn + delivered.counts.warn } }
}

function checkOf(name, bytes, parsed, entries = [{ path: SKILL_MD, bytes }]) {
  const scan = file => checkSkill([{ path: SKILL_MD, bytes: file }], { expectedName: name })
  const raw = checkSkill(entries, { expectedName: name })
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
const treeSource = kind => kind === 'folder' || kind === 'archive'
const sourceLabel = value => wellFormed(value) && value.length > 0 && Buffer.byteLength(value) <= 255 &&
  value !== '.' && value !== '..' && !/[/\\\p{Cc}\p{Cf}]/u.test(value)
const archiveName = name => sourceLabel(name) && skillArchiveKind(name)

function archiveBytes(body) {
  if (!archiveName(body.fileName) || typeof body.fileBytes !== 'string') throw reject(ARCHIVE_FORMAT)
  if (body.fileBytes.length > ARCHIVE_BASE64_MAX) throw reject(ARCHIVE_LARGE)
  const bytes = Buffer.from(body.fileBytes, 'base64')
  if (bytes.length > ARCHIVE_INPUT_MAX) throw reject(ARCHIVE_LARGE)
  if (bytes.toString('base64') !== body.fileBytes) throw reject(ARCHIVE_FORMAT)
  return bytes
}

function treeDocument(name, entries, checks) {
  const bytes = entries.find(entry => entry.path === SKILL_MD).bytes
  const parsed = parseSkillMd(bytes)
  const key = checks && JSON.stringify([name, SKILL_CHECK_FINGERPRINT, skillHash(entries)])
  let check = checks?.get(key)
  if (!check) {
    check = checkOf(name, bytes, parsed, entries)
    checks?.set(key, check)
    if (checks?.size > 64) checks.delete(checks.keys().next().value)
  }
  const frontmatter = fromUtf8(bytes)
  return { bytes, entries, parsed, check, frontmatter }
}

function treeManifest(entries, check) {
  const scripts = check.uses.scripts.map(({ path, interpreter }) => ({ path, interpreter }))
  const scriptPaths = new Set(scripts.map(script => script.path))
  const references = entries.filter(entry => entry.path.startsWith('references/')).map(entry => entry.path)
  const tree = entries.map(({ path, bytes }) => ({ path, size: bytes.length,
    kind: path === SKILL_MD ? 'skill' : scriptPaths.has(path) ? 'script' : path.startsWith('references/') ? 'reference' : 'other' }))
  return { tree, scripts, references }
}

function diffEntries(entries) {
  const bytes = new Map(entries.map(entry => [entry.path, entry.bytes]))
  return fileEntries(entries).map(entry => ({ ...entry, bytes: bytes.get(entry.path) }))
}

function storedTree(name, record, checks) {
  if (typeof record.frontmatter !== 'string' || Buffer.byteLength(record.frontmatter) > LIMITS.skillMd ||
      !wellFormed(record.frontmatter) || !Array.isArray(record.files) ||
      record.files.length >= LIMITS.files ||
      (record.source.kind === 'folder' ? !sourceLabel(record.source.folderName) : !archiveName(record.source.fileName))) return
  const entries = [{ path: SKILL_MD, bytes: Buffer.from(record.frontmatter) }]
  let total = entries[0].bytes.length
  let last
  for (const file of record.files) {
    if (!file || typeof file.path !== 'string' || file.path === SKILL_MD || typeof file.text !== 'string' ||
        (last !== undefined && pathOrder(last, file.path) >= 0)) return
    const size = Buffer.byteLength(file.text)
    total += size
    if (size > LIMITS.file || total > LIMITS.total || !wellFormed(file.text)) return
    last = file.path
    entries.push({ path: file.path, bytes: Buffer.from(file.text) })
  }
  try { validateSkillTree(entries) } catch { return }
  const document = treeDocument(name, entries, checks)
  const { parsed, check } = document
  return { ...document, valid: parsed.ok && parsed.name === name && parsed.description === record.description &&
    parsed.body === record.content && check.hash === record.hash }
}

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
  const location = first?.path && first.path !== SKILL_MD ? `${first.path}, line ${line}` : `line ${line}`
  return Object.assign(reject(`Not saved: ${reason} (${location}). ${help}`), { auditReason: `${first?.rule ?? 'blocked'} line ${line}` })
}

function storedDocument(name, record, checks) {
  if (!record || record.name !== name || reservedCommandOf(name) ||
      !validDescription(record.description) || !wellFormed(record.content) ||
      !record.source) return
  if (treeSource(record.source.kind)) return storedTree(name, record, checks)
  if (!['text', 'file'].includes(record.source.kind)) return
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
  const previewJobs = new Map()
  const previews = new Map()
  const treeChecks = new Map()
  let previewing = false
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
      try { publishHostFile(keyPath, randomBytes(32)) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const before = stat(keyPath)
    if (before && (!before.isFile() || !privateMode(before) || !owned(before) ||
        !hasOnlyHostPublicationLinks(keyPath, before))) throw notWritable()
    let fd
    try {
      fd = fs.openSync(keyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile() || !sameInode(info, before) || !privateMode(info) || !owned(info) ||
          !hasOnlyHostPublicationLinks(keyPath, info) || info.size !== 32) throw notWritable()
      return fs.readFileSync(fd)
    } finally { fs.closeSync(fd) }
  }

  const mac = (key, ...value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
  // An older review seal cannot establish provider-observed completion.
  const attestation = (key, review) => mac(key, 'review-v3', hashJson(review))
  const acceptance = (key, record, fingerprint, digest, findingsDigest) =>
    mac(key, 'accept-v2', record.name, record.source, record.hash, fingerprint, digest, findingsDigest)
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

  function checkedRecord(name, record, data, key) {
    const document = storedDocument(name, record, treeChecks)
    const tree = treeSource(record?.source?.kind) ? { source: { kind: record.source.kind } } : {}
    if (!document) return { name, held: CHANGED, ...tree }
    const { check, parsed, valid } = document
    if (check.injection.length || blockFor(data, check.hash, key)) return { name, held: HELD_INJECTION, ...tree }
    if (check.verdict === 'block') return { name, held: checkFailure(check).message, ...tree }
    if (!valid) return { name, held: CHANGED, ...tree }
    const review = verifies(key, check.hash, record.review, record.reviewSeal) ? record.review : undefined
    if (review?.findings.some(finding => finding.area === 'prompt-injection')) return { name, held: HELD_INJECTION, ...tree }
    // An old import copied the library verbatim. Only a proof bound to this home
    // and record can establish local origin for a legacy typed record.
    const legacy = !holdPreexistingTyped && key && !stat(importMark) &&
      record.source.kind === 'text' && record.review === undefined &&
      record.reviewSeal === undefined && SKILL_CHECK_HISTORY[record.check?.version] === record.check?.fingerprint &&
      record.check?.fingerprint !== undefined && record.check.fingerprint !== SKILL_CHECK_FINGERPRINT &&
      check.verdict === 'pass' && equalMac(record.localProvenance, mac(key, 'local-legacy-v1',
        fs.realpathSync(rt.home), name, check.hash, record.check.fingerprint))
    const digest = review && hashJson(review)
    const needsConfirm = review && (check.verdict === 'warn' || review.findings.length) &&
      (record.accepted !== check.hash || record.acceptedReview !== digest ||
        !equalMac(record.acceptanceSeal, acceptance(key, record, check.fingerprint, digest,
          hashJson(reportFindings(check, review.findings)))))
    const held = check.truncated ? INCOMPLETE : !review && !legacy ? REVIEW_NEEDED
      : needsConfirm ? CONFIRM : undefined
    const current = record.check?.version === check.version && record.check?.fingerprint === check.fingerprint
    const source = record.source.kind === 'folder' ? { kind: 'folder', folderName: record.source.folderName }
      : record.source.kind === 'text' ? { kind: 'text' } : { kind: record.source.kind, fileName: record.source.fileName }
    return { name, description: parsed.description, content: parsed.body, hash: check.hash, source,
      check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict,
        ranAt: current && Number.isFinite(record.check?.ranAt) ? record.check.ranAt : Date.now(),
        findings: checkFindings(check), truncated: check.truncated, counts: check.counts },
      ...(review ? { review } : {}), ...(held ? { held } : {}),
      ...(document.entries && !held ? treeManifest(document.entries, check) : {}),
      ...(held === REVIEW_NEEDED || held === CONFIRM ? { reviewHash: check.hash } : {}) }
  }

  function snapshot(fresh = false) {
    const rootInfo = directory()
    const info = rootInfo && stat(path)
    const stamp = fileStamp(info)
    const trust = JSON.stringify([fileStamp(stat(keyPath)), fileStamp(stat(importMark))])
    const generation = JSON.stringify(rt.teamGeneration())
    if (!fresh && cache && cache.stamp === stamp && cache.trust === trust && cache.generation === generation) return cache
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
    const skills = new Map(Object.entries(data.skills).filter(([name]) => skillName(name))
      .map(([name, record]) => [name, checkedRecord(name, record, data, key)]))
    cache = { data, stamp, trust, generation, skills }
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

  function auditReviewRefusal(name, identity, generation, { why, review }) {
    authorizedGeneration(generation)
    const reason = why === 'review-failed' && review?.why ? `review-failed:${review.why}` : why ?? 'deterministic'
    audit('skill-library-save', { name }, identity, 'refused', reason)
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

  function reviewReceipt(check, reviewDigest, findingsDigest, identity, generation) {
    return mac(confirmationKey, 'confirm-v2', identity, generation, check.hash, check.fingerprint, reviewDigest, findingsDigest)
  }

  function decisionOf(check, review, blocked, identity, generation) {
    const findings = reportFindings(check, [...(review?.findings ?? []), ...(blocked ?? [])])
    const reviewDigest = review?.status === 'done' ? hashJson(review) : null
    const findingsDigest = hashJson(findings)
    const out = { findings, findingsDigest, review, reviewDigest, blocked,
      truncated: check.truncated || review?.why === 'overflow', counts: check.counts }
    if (check.injection.length || blocked || findings.some(finding => finding.injection)) {
      return { ...out, decision: 'refuse', why: 'injection', message: INJECTION }
    }
    if (check.verdict === 'block') return { ...out, decision: 'block', message: checkFailure(check).message }
    if (check.truncated) return { ...out, decision: 'refuse', why: 'incomplete', message: INCOMPLETE }
    if (review?.status === 'none') return { ...out, decision: 'refuse', why: 'no-model', message: NO_MODEL }
    if (review?.status !== 'done') return { ...out, decision: 'refuse', why: 'review-failed', message: REVIEW_FAILED }
    if (!findings.length) return { ...out, decision: 'accept' }
    return { ...out, decision: 'confirm', receipt: reviewReceipt(check, reviewDigest, findingsDigest, identity, generation) }
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
          const all = uniqueModelFindings([...previous, ...findings])
          if (previous.length === all.length) return
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
      const record = checkedRecord(name, previous, data, hostKey())
      if (!record.reviewHash && !record.held) throw reject(CHANGED, 'bot/refused')
      return { ...document, previous, source: previous.source, frontmatter: previous.frontmatter }
    }
    if (treeSource(previous?.source?.kind)) throw reject(REPLACE_REQUIRED, 'bot/refused')
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
    return { bytes, entries: [{ path: SKILL_MD, bytes }], parsed, check, previous, source, frontmatter }
  }

  function saveView(decision, findings = decision.findings) {
    const { review, truncated, counts } = decision
    if (decision.decision === 'confirm') return { needsConfirm: decision.receipt, findings, review, truncated, counts }
    return { refused: true, message: decision.message, findings, review, truncated, counts }
  }

  async function writeSkill(document, name, source, previous, decision, key, data, generation, stamp) {
    const { check, parsed, frontmatter, entries } = document
    const now = Date.now()
    const record = {
      name, description: parsed.description, content: parsed.body, source, createdAt: previous?.createdAt ?? now,
      updatedAt: now, hash: check.hash,
      check: { version: check.version, fingerprint: check.fingerprint, verdict: check.verdict,
        ranAt: now, findings: checkFindings(check) },
      ...(frontmatter === undefined ? {} : { frontmatter }),
      review: decision.review, reviewSeal: attestation(key, decision.review),
    }
    if (treeSource(source.kind)) {
      record.revision = randomUUID()
      record.files = entries.filter(entry => entry.path !== SKILL_MD)
        .map(({ path, bytes }) => ({ path, text: fromUtf8(bytes) }))
    }
    if (decision.decision === 'confirm') {
      record.accepted = check.hash
      record.acceptedReview = decision.reviewDigest
      record.acceptanceSeal = acceptance(key, record, check.fingerprint, decision.reviewDigest, decision.findingsDigest)
    }
    await write({ ...data, skills: { ...data.skills, [name]: record } }, generation, stamp)
    return { saved: true }
  }

  function replacementBaseline(previous, verified) {
    return hashJson([previous, verified?.held, verified?.review])
  }

  function prunePreviews(table, limit = PREVIEW_LIMIT) {
    for (const [id, entry] of table) if (entry.expires <= Date.now()) table.delete(id)
    for (const [id, entry] of table) {
      if (table.size <= limit) break
      if (entry.expires !== undefined) table.delete(id)
    }
  }

  async function previewTree(body, caller) {
    if (previewing) throw reject(PREVIEW_BUSY, 'bot/refused')
    previewing = true
    try {
      const folder = body.source === 'folder'
      const result = folder ? readSkillFolder(body.path)
        : await readSkillArchive(archiveBytes(body), { kind: skillArchiveKind(body.fileName) })
      const { entries, skipped } = result
      const source = folder ? { kind: 'folder', folderName: result.folderName } : { kind: 'archive', fileName: body.fileName }
      if (folder && !sourceLabel(source.folderName)) throw reject('Choose a folder with a valid name.')
      const parsedName = parseSkillMd(entries.find(entry => entry.path === SKILL_MD).bytes).name
      const edit = body.edit === true
      const name = edit ? body.name : parsedName
      const document = treeDocument(name, entries)
      const { check, parsed } = document
      const manifest = treeManifest(entries, check)
      const view = { preview: true, name, description: parsed.description, files: manifest.tree, ...manifest, skipped }
      if (skillName(name) && reservedCommandOf(name)) {
        throw reject(`The name ${name} is reserved for the /${name} command. Choose another name.`)
      }
      if (check.verdict !== 'block' && !validDescription(parsed.description)) throw reject(DESCRIPTION)
      const { data, skills } = snapshot(true)
      const previous = own(data.skills, name)
      if (edit && !previous) throw reject('Unknown skill', 'bot/not-found')
      if (edit && !treeSource(previous.source?.kind)) throw reject(REPLACE_REQUIRED, 'bot/refused')
      if (!edit && previous) throw reject(`A skill named ${name} already exists. Edit it, or choose another name.`)
      const verified = edit ? skills.get(name) : undefined
      const baseline = edit ? replacementBaseline(previous, verified) : undefined
      const earlier = verified && !verified.held ? storedDocument(name, previous, treeChecks) : undefined
      const decision = await reviewSkill({ name, entries, check, caller })
      const { identity, generation } = caller
      const findings = treeReportFindings(check, decision)
      if (earlier || edit) {
        view.diff = {
          ...(earlier ? { files: compareFiles(diffEntries(earlier.entries), diffEntries(entries)) } : { held: true }),
          findings: findingDelta(earlier ? treeReportFindings(earlier.check, verified) : [], findings),
        }
      }
      if (decision.decision === 'block' || decision.decision === 'refuse') {
        if (decision.decision === 'block' && (!parsed.ok || !parsed.name || !parsed.description)) {
          decision.message = 'SKILL.md needs a name and a one-line description in its frontmatter.'
        }
        auditReviewRefusal(name, identity, generation, decision)
        return { ...view, ...saveView(decision, findings) }
      }
      const token = randomBytes(16).toString('hex')
      previews.set(token, { identity, generation: JSON.stringify(generation), name, edit, baseline, source, entries,
        hash: check.hash, reviewDigest: decision.reviewDigest, expires: Date.now() + PREVIEW_TTL })
      prunePreviews(previews)
      return { ...view, token, ...(decision.decision === 'confirm' ? saveView(decision, findings)
        : { findings, review: decision.review }) }
    } finally { previewing = false }
  }

  function saveTree(body, identity, generation) {
    return serial(async () => {
      authorizedGeneration(generation)
      prunePreviews(previews)
      const preview = previews.get(body.token)
      if (!preview || preview.identity !== identity || preview.generation !== JSON.stringify(generation)) {
        throw reject(PREVIEW_EXPIRED, 'bot/refused')
      }
      const { name, source } = preview
      const { data, stamp, skills } = snapshot(true)
      const previous = own(data.skills, name)
      if (preview.edit ? !previous || replacementBaseline(previous, skills.get(name)) !== preview.baseline : previous) {
        previews.delete(body.token)
        throw reject(preview.edit ? REPLACE_CHANGED : `A skill named ${name} already exists. Edit it, or choose another name.`, 'bot/refused')
      }
      const document = treeDocument(name, preview.entries)
      const { check } = document
      if (check.hash !== preview.hash) throw reject(CHANGED, 'bot/refused')
      const key = hostKey()
      const decision = decisionOf(check, cachedReview(data, check.hash, key), blockFor(data, check.hash, key), identity, generation)
      if (decision.decision === 'block' || decision.why === 'injection') {
        previews.delete(body.token)
        auditReviewRefusal(name, identity, generation, decision)
        return saveView(decision, treeReportFindings(check, decision))
      }
      if (decision.reviewDigest !== preview.reviewDigest) {
        previews.delete(body.token)
        throw reject(PREVIEW_EXPIRED, 'bot/refused')
      }
      if (decision.decision !== 'accept' && (decision.decision !== 'confirm' || !equalMac(body.confirm, decision.receipt))) {
        return saveView(decision, treeReportFindings(check, decision))
      }
      const result = await writeSkill(document, name, source, previous, decision, key, data, generation, stamp)
      previews.delete(body.token)
      audit('skill-library-save', { name }, identity, 'allowed', 'review-done')
      return result
    })
  }

  async function save(body, identity, generation) {
    const action = 'skill-library-save'
    try {
      authorizedGeneration(generation)
      const { name } = body
      const first = prepareSave(snapshot(true).data, body)
      const reviewed = await reviewSkill({ name, entries: first.entries ?? [{ path: SKILL_MD, bytes: first.bytes }],
        check: first.check, caller: { identity, generation } })
      if (reviewed.decision === 'block' || reviewed.decision === 'refuse') {
        auditReviewRefusal(name, identity, generation, reviewed)
        return saveView(reviewed)
      }

      return await serial(async () => {
        authorizedGeneration(generation)
        const { data, stamp } = snapshot(true)
        if (JSON.stringify(own(data.skills, name)) !== JSON.stringify(first.previous)) throw reject(CHANGED, 'bot/refused')
        const document = prepareSave(data, body)
        const { previous, bytes, check, source } = document
        if (!bytes.equals(first.bytes) || check.hash !== first.check.hash) throw reject(CHANGED, 'bot/refused')
        const key = hostKey()
        const decision = decisionOf(check, cachedReview(data, check.hash, key), blockFor(data, check.hash, key), identity, generation)
        if (decision.reviewDigest !== reviewed.reviewDigest) throw reject(CHANGED, 'bot/refused')
        if (decision.decision !== 'accept' && (decision.decision !== 'confirm' || !equalMac(body.confirm, decision.receipt))) {
          audit(action, body, identity, decision.decision === 'confirm' ? 'pending' : 'refused', decision.why ?? 'confirmation')
          return saveView(decision)
        }
        const result = await writeSkill(document, name, source, previous, decision, key, data, generation, stamp)
        audit(action, body, identity, 'allowed', 'review-done')
        return result
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
  function saveOperation(body, identity, generation, role) {
    authorizedGeneration(generation)
    const { operation, poll, recover, ...input } = body
    const preview = input.preview === true && treeSource(input.source)
    if (preview && input.source === 'folder' && role !== 'owner') throw reject(FOLDER_OWNER, 'bot/refused')
    if (preview && input.source === 'archive' && typeof input.fileBytes === 'string' &&
        input.fileBytes.length > ARCHIVE_BASE64_MAX) throw reject(ARCHIVE_LARGE)
    const run = () => preview ? previewTree(input, { identity, generation }) : input.token !== undefined
      ? saveTree(input, identity, generation) : save(input, identity, generation)
    if (operation === undefined) return run()
    if (typeof operation !== 'string' || !/^[a-f0-9]{32}$/.test(operation)) throw reject('Invalid Skills save operation.')
    const scope = JSON.stringify(generation)
    prunePreviews(previewJobs)
    const entry = saves.get(operation) ?? previewJobs.get(operation)
    if (entry) {
      if (entry.scope !== scope || entry.identity !== identity) {
        throw reject('This Skills save is no longer available. Save the skill again.', 'bot/not-found')
      }
      if (poll !== true && entry.inputHash !== hashJson(input)) throw reject(CHANGED, 'bot/refused')
      if (entry.error) throw entry.error
      if (poll === true && recover === true && entry.form) return { ...entry.result, form: entry.form }
      return entry.result ?? { pending: true }
    }
    if (poll === true) throw reject('This Skills save is no longer available. Save the skill again.', 'bot/not-found')
    const job = { scope, identity, inputHash: hashJson(input) }
    if (preview && previewing) throw reject(PREVIEW_BUSY, 'bot/refused')
    const jobs = preview ? previewJobs : saves
    jobs.set(operation, job)
    if (preview) prunePreviews(previewJobs)
    const finishPreview = () => {
      if (preview) job.expires = Date.now() + PREVIEW_TTL
    }
    void run().then(result => {
      finishPreview()
      job.result = result
      // The initiating viewer may be gone before it receives a warning. Keep
      // its exact form with the result, behind the same actor and team checks.
      if (result.needsConfirm && !preview) {
        const fields = input.reviewHash === undefined ? ['name', 'description', 'content', 'source', 'fileName', 'fileBytes']
          : ['name', 'reviewHash']
        if (input.token !== undefined) fields.push('token')
        job.form = Object.fromEntries(fields.filter(key => typeof input[key] === 'string').map(key => [key, input[key]]))
        job.form.edit = input.edit === true
      }
    }, error => { finishPreview(); job.error = error })
    return { pending: true }
  }

  function active(botId) {
    if (typeof botId !== 'string' || !rt.botOf(botId) || rt.teamCurrent?.() === false) return []
    try {
      const { data, skills } = snapshot()
      return asList(assignments(own(data.active, botId), skills))
        .filter(({ name }) => !skills.get(name).held)
        .map(({ name, mode }) => {
          const { tree, scripts, references, ...record } = skills.get(name)
          return { ...record, mode }
        })
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

    if (action === 'skill-library-save') return saveOperation(body, identity, generation, caller.role)

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
