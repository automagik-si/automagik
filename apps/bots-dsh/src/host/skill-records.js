import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { syncContainingDirectory } from './files.js'
import { skillRefusal } from './skill-keys.js'
import {
  createSkillStore, fileEntries, manifestOf, SkillFilesChanged, skillHash, skillHashId, skillName, skillPath,
  skillPreflight, storeCode, textSkillFields, textSkillMd, validManifest,
} from './skill-store.js'
import { own } from './store.js'

const SOURCE_KINDS = ['text', 'file', 'bot', 'learned']
const FINDING_AREAS = ['structure', 'secrets', 'prompt-injection', 'dangerous-commands', 'external-endpoints', 'scripts-binaries', 'run-or-grant']
const WRITERS = ['settings-form', 'learning-card', 'preview', 'bot']
export const skillMirror = item => createHash('sha256')
  .update(JSON.stringify([item.description ?? '', item.content ?? ''])).digest('hex')

function canonicalRecordJSON(value) {
  if (Array.isArray(value)) return `[${Array.from(value, entry => canonicalRecordJSON(entry) ?? 'null').join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const fields = []
  for (const key of Object.keys(value).sort()) {
    const encoded = canonicalRecordJSON(value[key])
    if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${fields.join(',')}}`
}

export const skillRecordId = item => createHash('sha256').update(canonicalRecordJSON(item)).digest('hex')

const textEntries = item => [{ path: 'SKILL.md', bytes: textSkillMd(item) }]
const oneBody = files => Array.isArray(files) && files.length === 1 && files[0]?.path === 'SKILL.md'
const textMatches = (entries, hash) => skillHash(entries) === hash
const validSource = source => source && SOURCE_KINDS.includes(source.kind)
  && (source.moved === undefined || source.moved === true)
  && (source.fileName === undefined || typeof source.fileName === 'string')
  && Object.keys(source).every(key => ['kind', 'moved', 'fileName'].includes(key))
const optionalString = value => value === undefined || typeof value === 'string'
const movedLegacy = generation => generation?.via === 'move' ? generation.legacy : undefined
const deletionHash = item => skillHashId(item.hash) ? item.hash : null
const changes = () => skillRefusal('changed-elsewhere')
const badStore = error => skillRefusal('store-failed', { code: storeCode(error) })

function hasImportHold(items, name, item) {
  const id = own(items, name)
  return id !== undefined && id === skillRecordId(item)
}

export function skillDeleteBinding(expect) {
  const { kind, id, team } = expect ?? {}
  if (kind !== 'skill' || !skillHashId(id) || !Object.hasOwn(expect, 'kind') || !Object.hasOwn(expect, 'id')
    || !Object.hasOwn(expect, 'team') || !Object.hasOwn(team ?? {}, 'epoch') || !Object.hasOwn(team, 'term')
    || !Number.isSafeInteger(team.epoch) || !Number.isSafeInteger(team.term)
    || Object.keys(expect).length !== 3 || Object.keys(team).length !== 2) throw changes()
  return { kind, id, team: { epoch: team.epoch, term: team.term } }
}

export function validSkillRecord(item, generation) {
  return item.skillFormat === 1 && skillName(item.name) && skillHashId(item.hash) && skillHashId(item.mirror)
    && validManifest(item.files, item.hash, movedLegacy(generation)) && validSource(item.source)
    && optionalString(item.authorModel) && (item.authorModel === undefined || ['bot', 'learned'].includes(item.source.kind))
    && item.review === undefined && item.accepted === undefined
    && (item.check === undefined ? item.suspended === undefined : validCheck(item, generation))
}

function validCheck({ hash, check, suspended }, generation) {
  if (!check || check.hash !== hash || check.legacy !== (generation?.via === 'move')
    || !['pass', 'warn', 'block'].includes(check.verdict) || !Number.isInteger(check.version)
    || !skillHashId(check.fingerprint) || !Number.isFinite(check.checkedAt) || typeof check.truncated !== 'boolean'
    || !Array.isArray(check.findings)) return false
  if (suspended !== undefined && (suspended !== true || check.verdict !== 'block')) return false
  const counts = { block: 0, warn: 0 }
  for (const finding of check.findings) {
    if (!finding || !Object.hasOwn(counts, finding.level)) return false
    if (typeof finding.rule !== 'string' || typeof finding.key !== 'string' || typeof finding.reason !== 'string'
      || !FINDING_AREAS.includes(finding.area) || !skillPath(finding.path)
      || (finding.line !== null && (!Number.isSafeInteger(finding.line) || finding.line < 1))) return false
    counts[finding.level]++
  }
  return Object.keys(counts).every(level => Number.isInteger(check.counts?.[level]) && check.counts[level] >= counts[level])
}

function preRfc(item) {
  return item.skillFormat === undefined && item.hash === undefined
}

function finishJournal(row, hash) {
  row.generations[hash].state = 'committed'
  row.committed = hash
  if (row.pending?.op === 'create') delete row.deleted
  delete row.pending
}

export function installSkillRecords(rt, { library, deleteFrom, input, validateName, authorizeEdit }) {
  const context = new AsyncLocalStorage()
  const queues = new Map()
  const failures = new Map()
  const warnedUnknown = new Set()
  const importPath = join(rt.home, '.skills-import.json')
  let store
  let storeMode
  let storeRevision
  let ledgerChain = Promise.resolve()
  let readiness
  let readyRevision
  let retry = false

  const itemOf = name => own(library(), name)
  const teamKey = () => {
    const { epoch, term } = rt.teamGeneration()
    return `${epoch}:${term}`
  }
  const canWrite = () => rt.canWriteTeam() && rt.holdsLock()
  const assertTeam = team => { if (!rt.sameTeam(team)) throw changes() }
  const writeStore = (team, fn) => {
    assertTeam(team)
    return fn(getStore())
  }
  function getStore() {
    const mode = canWrite() ? 'write' : 'read'
    const key = teamKey()
    if (!store || storeMode !== mode || storeRevision !== key || !store.bound().ok) {
      storeMode = mode
      storeRevision = key
      store = createSkillStore(rt.home, { mode })
    }
    return store
  }
  function skillQueue(name, fn) {
    if (!skillName(name)) throw skillRefusal('name-format')
    const running = context.getStore()
    if (running?.name === name && running.active) throw new Error('The skill queue cannot be entered twice for the same name.')
    const token = { name, active: true }
    const run = (queues.get(name) ?? Promise.resolve()).then(() => context.run(token, async () => {
      try { return await fn(token) } finally { token.active = false }
    }))
    const done = run.then(() => {}, () => {})
    queues.set(name, done)
    void done.then(() => { if (queues.get(name) === done) queues.delete(name) })
    return run
  }
  function skillLedger(mutate, team = rt.teamGeneration()) {
    const run = ledgerChain.then(() => writeStore(team, current => {
      const value = current.readLedger()
      const result = mutate(value)
      assertTeam(team)
      current.writeLedger(value)
      return result
    }))
    ledgerChain = run.catch(() => {})
    return run
  }
  async function saveRecord(name, beforeCommit, item, displayedTeam) {
    const change = item ? state => { state.capabilities.items[name] = item } : state => deleteFrom(state, name)
    try {
      await rt.saveCopy(change, { beforeCommit, afterWrite: () => change(rt.state), durable: true })
    } catch (error) {
      if (error.key) throw error
      if (displayedTeam && (error.code === 'ELOCKLOST' || (!error.code && !rt.sameTeam(displayedTeam)))) throw changes()
      throw badStore(error)
    }
  }
  function assertHeld(held, name) {
    if (context.getStore() !== held || !held.active || held.name !== name) throw new Error('The skill name lock is required.')
  }

  function updateImportHolds(team, update) {
    writeStore(team, storage => {
      const value = storage.readImportHolds()
      if (update(value.items)) storage.writeImportHolds(value)
    })
  }

  function forgetImportHold(name, team) {
    updateImportHolds(team, items => Object.hasOwn(items, name) && delete items[name])
  }

  async function finishDelete(name, team) {
    const check = () => {
      assertTeam(team)
      if (!rt.teamCurrent() || !rt.capabilitiesIntact() || itemOf(name) !== undefined) throw changes()
    }
    check()
    await rt.removeSkillLearning?.(name, check)
    check()
    forgetImportHold(name, team)
    await skillLedger(ledger => {
      check()
      const row = ledger.names[name]
      const { at, preserve } = row.deleting
      delete row.deleting
      if (preserve) {
        if (Object.keys(row).length === 1 && !Object.keys(row.generations).length) delete ledger.names[name]
      } else {
        row.deleted = at
        delete row.committed
        delete row.pending
      }
    }, team)
    failures.delete(name)
  }

  async function finishAbsentDelete(name, team, row) {
    if (!row?.deleting || itemOf(name) !== undefined) return
    rt.syncTeamState(team)
    await finishDelete(name, team)
  }

  async function commitLocked(held, request) {
    const { name, op, team, via, source, authorModel, writer, creator, accept, admit, preview, imported, expect } = request
    assertHeld(held, name)
    assertTeam(team)
    const store = getStore()
    let row = own(store.readLedger().names, name)
    if (row?.deleting && itemOf(name) === undefined) {
      await finishAbsentDelete(name, team, row)
      row = own(store.readLedger().names, name)
    }
    const previous = itemOf(name)
    const oldGeneration = own(row?.generations ?? {}, previous?.hash)
    const original = op === 'restore' ? own(row?.generations ?? {}, request.hash) : oldGeneration
    // The transaction owns its bytes. The gate receives an independent view of them.
    const allowance = op === 'migrate' ? true : ['restore', 'repair'].includes(op) && !imported ? movedLegacy(original) : undefined
    const { entries } = skillPreflight(request.entries, { legacyBody: allowance })
    const files = fileEntries(entries)
    const hash = skillHash(files)
    const description = request.description ?? ''
    const content = request.content ?? ''
    const mirror = skillMirror({ description, content })
    const checkCurrent = () => {
      assertTeam(team)
      if (itemOf(name) !== previous) throw changes()
      if (op === 'reconcile' && (previous.hash ?? null) !== expect.hash) throw changes()
      if (op === 'reconcile' && skillMirror(previous) !== expect.mirror) throw changes()
    }
    if (op === 'create') {
      if (previous) throw skillRefusal('name-taken', { name })
    } else {
      if (!previous || previous.kind !== 'skill') throw op === 'edit' ? changes() : skillRefusal('not-found', { name })
      if (previous.name !== name || (previous.skillFormat !== undefined && previous.skillFormat !== 1)) throw skillRefusal('record-invalid')
    }
    if (op === 'edit') {
      if (!skillHashId(request.base)) throw skillRefusal('hash-format')
      if (previous.hash !== request.base) throw changes()
      if (!(rt.validSkillRecord ?? validSkillRecord)(previous, oldGeneration)) throw skillRefusal('record-invalid')
    }
    if (op === 'create' && request.base !== undefined) throw skillRefusal('hash-format')
    const expected = op === 'repair' ? previous.hash : op === 'restore' ? request.hash ?? previous.hash : undefined
    if (expected !== undefined && expected !== hash) throw new SkillFilesChanged()
    if (op === 'reconcile' && (row?.committed ?? null) !== expect.committed) throw changes()
    checkCurrent()
    validateName(name, { kind: 'skill', creating: op === 'create' })
    if (!validSource(source)) throw skillRefusal('record-invalid')
    const bytes = entries.find(entry => entry.path === 'SKILL.md').bytes
    let fields
    try { fields = rt.parseSkillMd?.(bytes) ?? textSkillFields(bytes) } catch {
      throw skillRefusal('record-invalid')
    }
    if (fields.ok === false || fields.name !== name) throw skillRefusal('rename', { name })
    const at = Date.now()
    const known = own(row?.generations ?? {}, hash)
    const legacy = !imported && (op === 'migrate' || known?.via === 'move')
    const trust = await rt.skillGate?.({
      name, hash, entries: entries.map(entry => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
      via, source: { ...source }, legacy, previous: !imported && previous ? structuredClone(previous) : undefined, writer, op, imported, accept,
    })
    checkCurrent()
    const item = {
      name, kind: 'skill', description, content,
      createdBy: previous ? previous.createdBy ?? null : creator ?? writer?.botId ?? null,
      createdAt: previous?.createdAt ?? at, updatedAt: at,
      skillFormat: 1, source: { ...source }, hash, files, mirror,
      ...(authorModel && ['bot', 'learned'].includes(source.kind) ? { authorModel } : {}),
      ...(trust ?? {}),
    }
    if (op === 'repair' || op === 'restore' || op === 'migrate') item.updatedAt = previous.updatedAt ?? at
    // Admission also runs immediately before persistence because the state writer can
    // queue behind another save while learning's privacy or secret inputs change.
    const admitItem = () => admit?.(structuredClone(item))
    admitItem()
    const exception = op === 'migrate' ? { size: files[0].size, sha256: files[0].sha256 } : allowance
    const priority = writer.host ? 'move' : writer.person ? 'person' : 'bot'
    const due = rt.skillReviewQueue && trust?.check?.verdict !== 'block'
    await skillLedger(value => {
      checkCurrent()
      const entry = own(value.names, name) ?? (value.names[name] = { generations: {} })
      if (op === 'reconcile' && (entry.committed ?? null) !== expect.committed) throw changes()
      if (entry.generations[hash]?.state !== 'committed') {
        entry.generations[hash] = {
          mirror, via, state: 'prepared', files: files.length, at,
          firstCheck: trust?.check ? 'done' : 'pending',
          ...(op === 'migrate' ? { legacy: exception } : {}),
          ...(due ? { reviewDue: { priority, writer } } : {}),
        }
      }
      entry.pending = { hash, mirror, via, at, op }
      if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) {
        throw skillRefusal('store-failed', { code: 'ledger-full' })
      }
      writeStore(team, storage => {
        if (op !== 'repair' || !storage.checkRepair(name, hash, exception)) {
          storage.writeManifest(name, hash, manifestOf(files), exception)
        }
      })
    }, team)
    checkCurrent()
    try {
      if (op === 'repair') store.repair(name, hash, entries, { legacyBody: exception })
      else store.publish(name, entries, { legacyBody: exception })
    } catch (error) { throw badStore(error) }
    await saveRecord(name, () => {
      checkCurrent()
      admitItem()
    }, item)
    await skillLedger(value => { finishJournal(value.names[name], hash) }, team)
    forgetImportHold(name, team)
    failures.delete(name)
    if (preview) writeStore(team, storage => storage.unstage(preview.token, hash))
    const review = due ? await rt.skillReviewQueue({
      subject: { name }, generation: store.read(name, hash, files, { legacyBody: exception }),
      authorModel: item.authorModel, team, priority, writer,
    }) : undefined
    return { item, review }
  }

  function skillCommit(request) {
    const { name, op, base, via } = request
    if (!skillName(name)) throw skillRefusal('name-format')
    if (!['create', 'edit'].includes(op) || !WRITERS.includes(via) || 'imported' in request || 'expect' in request) {
      throw skillRefusal('not-found', { name })
    }
    if (op === 'edit' && !skillHashId(base)) throw skillRefusal('hash-format')
    // Freeze public caller bytes before yielding to earlier work on this name.
    const candidate = { ...request, ...skillPreflight(request.entries) }
    return skillQueue(name, held => commitLocked(held, candidate))
  }

  function textRequest(body, options, team) {
    assertTeam(team)
    const previous = itemOf(String(body.name ?? '').trim())
    const op = options.op ?? (previous ? 'edit' : 'create')
    const base = options.base ?? (op === 'edit' ? previous?.hash : undefined)
    if (op === 'edit' && options.base !== undefined && previous?.hash !== base) throw changes()
    const item = input(body, options)
    const via = options.via ?? (options.ui ? 'settings-form' : 'bot')
    const person = options.ui || via === 'learning-card'
    return {
      name: item.name, op, base, via, team, entries: textEntries(item), description: item.description, content: item.content,
      writer: person ? { person: true } : { botId: options.botId },
      creator: item.createdBy,
      source: { kind: via === 'learning-card' ? 'learned' : options.ui ? 'text' : 'bot' },
      authorModel: options.authorModel,
      admit(candidate) {
        if (op === 'edit' && !options.ui) authorizeEdit(itemOf(item.name), options.botId, 'change')
        options.admit?.(candidate)
      },
    }
  }

  async function recordSkillCheckLocked(held, name, hash, fields, team) {
    assertHeld(held, name)
    assertTeam(team)
    const previous = itemOf(name)
    if (previous?.hash !== hash || previous.name !== name || previous.kind !== 'skill') return false
    const row = own(getStore().readLedger().names, name)
    const generation = own(row?.generations ?? {}, hash)
    const validate = rt.validSkillRecord ?? validSkillRecord
    if (!validate(previous, generation)) throw skillRefusal('record-invalid')
    const item = { ...previous }
    for (const field of ['check', 'uses', 'accepted', 'review', 'suspended']) {
      if (!Object.hasOwn(fields, field)) continue
      if (fields[field] === undefined) delete item[field]
      else item[field] = structuredClone(fields[field])
    }
    if (!validate(item, generation)) throw skillRefusal('record-invalid')
    await saveRecord(name, () => {
      assertTeam(team)
      if (itemOf(name) !== previous) throw changes()
    }, item)
    return true
  }

  function recordSkillCheck(name, hash, fields, { team = rt.teamGeneration() } = {}) {
    if (!skillHashId(hash)) throw skillRefusal('hash-format')
    return skillQueue(name, held => recordSkillCheckLocked(held, name, hash, fields, team))
  }

  function importedState() {
    const stat = lstatSync(importPath, { throwIfNoEntry: false })
    if (!stat) return undefined
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw skillRefusal('store-failed', { code: 'import-marker' })
    const value = JSON.parse(readFileSync(importPath, 'utf8'))
    if (value?.v !== 1 || typeof value.sourceHadStore !== 'boolean') throw skillRefusal('store-failed', { code: 'import-marker' })
    return value
  }

  function setFailure(name, state, why) {
    failures.set(name, { state, ...(why ? { why } : {}) })
  }
  function provenance(item) {
    if (item.createdBy == null) return 'text'
    return rt.learnedSkillNames?.().has(item.name) ? 'learned' : 'bot'
  }

  async function reconcileName(held, name, team, marker, heldImports) {
    const item = itemOf(name)
    const storage = getStore()
    let row = own(storage.readLedger().names, name)
    if (row?.deleting && item && deletionHash(item) !== row.deleting.hash) return setFailure(name, 'changed')
    if (row?.deleting) {
      if (!rt.teamCurrent()) throw changes()
      if (item) await skillLedger(ledger => { delete ledger.names[name].deleting }, team)
      else await finishAbsentDelete(name, team, row)
      row = own(storage.readLedger().names, name)
    }
    if (!item || item.kind !== 'skill') {
      if (row?.pending) await skillLedger(ledger => { delete ledger.names[name].pending }, team)
      return
    }
    if (hasImportHold(heldImports, name, item)) return
    const mirror = skillMirror(item)
    let gen = own(row?.generations ?? {}, item.hash)
    const pending = row?.pending
    if (pending && item.hash === pending.hash && item.mirror === pending.mirror && mirror === pending.mirror
      && item.name === name && (rt.validSkillRecord ?? validSkillRecord)(item, gen)) {
      storage.readManifest(name, item.hash, movedLegacy(gen))
      rt.syncTeamState(team)
      await skillLedger(ledger => { finishJournal(ledger.names[name], item.hash) }, team)
      row = own(storage.readLedger().names, name)
      gen = own(row.generations, item.hash)
    }
    const importing = marker && !(gen?.state === 'committed' && ['move', 'import'].includes(gen.via) && row.committed === item.hash)
    if (importing && (item.name !== name || (item.skillFormat !== 1 && !preRfc(item))
      || !optionalString(item.description) || !optionalString(item.content))) {
      heldImports[name] = skillRecordId(item)
      return
    }
    if (item.skillFormat > 1) return setFailure(name, 'newer-format')
    if (item.name !== name) return setFailure(name, 'malformed')
    const host = { name, team, writer: { host: true }, description: item.description, content: item.content }
    const move = () => commitLocked(held, {
      ...host, entries: textEntries(item), op: 'migrate', via: 'move', source: { kind: provenance(item), moved: true },
    })

    if (importing) {
      const interruptedMove = !row?.committed && pending?.op === 'migrate' && pending.mirror === mirror
      if (preRfc(item) && !marker.sourceHadStore && (!row || interruptedMove)) await move()
      else {
        const entries = textEntries(item)
        if (preRfc(item) || (item.skillFormat === 1 && oneBody(item.files) && textMatches(entries, item.hash))) {
          await commitLocked(held, { ...host, entries, op: 'restore', imported: true, via: 'import', source: { kind: 'text' } })
        } else heldImports[name] = skillRecordId(item)
      }
      return
    }

    if (preRfc(item) && row && !row.committed) return setFailure(name, 'changed', 'older-edit')
    if (row?.pending) {
      await skillLedger(ledger => { delete ledger.names[name].pending }, team)
      row = own(storage.readLedger().names, name)
    }
    if (preRfc(item) && !row) {
      await move()
      return
    }
    if (!preRfc(item) && !(rt.validSkillRecord ?? validSkillRecord)(item, gen)) return setFailure(name, 'malformed')
    const committed = own(row?.generations ?? {}, row?.committed)
    if (preRfc(item) || mirror !== item.mirror) {
      const hash = row?.committed
      if (!hash) return setFailure(name, 'changed', 'older-edit')
      let manifest
      try { manifest = getStore().readManifest(name, hash, movedLegacy(committed)) } catch (error) {
        if (!(error instanceof SkillFilesChanged)) throw error
        return setFailure(name, 'changed', 'older-edit')
      }
      if (preRfc(item) && committed.mirror === mirror) {
        const snapshot = getStore().read(name, hash, manifest, { legacyBody: movedLegacy(committed) })
        await commitLocked(held, {
          ...host, entries: snapshot, hash, op: 'restore', via: committed.via,
          source: { kind: provenance(item), ...(committed.via === 'move' ? { moved: true } : {}) },
        })
      } else if (oneBody(manifest) && (preRfc(item) || oneBody(item.files))) {
        await commitLocked(held, {
          ...host, entries: textEntries(item), op: 'reconcile', via: 'older-edit', source: { kind: provenance(item) },
          expect: { hash: item.hash ?? null, mirror, committed: hash },
        })
      } else setFailure(name, 'changed', 'older-edit')
      return
    }
    if (storage.verify(name, item.hash, item.files, { legacyBody: movedLegacy(gen), capture: false })) {
      if (!gen) {
        assertTeam(team)
        storage.writeManifest(name, item.hash, manifestOf(item.files))
        await skillLedger(ledger => {
          const entry = own(ledger.names, name) ?? (ledger.names[name] = { generations: {} })
          entry.committed = item.hash
          entry.generations[item.hash] = {
            mirror, via: 'restore', state: 'committed', files: item.files.length, at: Date.now(), firstCheck: 'done',
          }
        }, team)
      }
    } else {
      if (!oneBody(item.files)) return setFailure(name, 'changed')
      // Inspect the tree before building or journaling a replacement.
      storage.checkRepair(name, item.hash, movedLegacy(gen))
      const entries = textEntries(item)
      if (!textMatches(entries, item.hash)) return setFailure(name, 'changed')
      await commitLocked(held, { ...host, entries, op: 'repair', via: gen?.via ?? 'restore', source: item.source, authorModel: item.authorModel })
    }
  }

  function roots(name, item, row) {
    const values = rt.skillGcRoots?.()
    return new Set([
      item?.hash, row.committed, row.pending?.hash, ...(values?.get(name) ?? []), ...(rt.skillMountRoots?.(name) ?? []),
    ])
  }
  async function collectName(name, team, removing = false) {
    const storage = getStore()
    const row = own(storage.readLedger().names, name)
    if (!row || row.deleting) return
    const item = itemOf(name)
    if (item?.skillFormat > 1) return
    const keep = roots(name, item, row)
    // A hashless item with no committed generation is ambiguous. Preserve its folders.
    if (item && !item.hash && !row.committed) return
    const generations = Object.entries(row.generations).filter(([hash]) => !keep.has(hash))
      .map(([hash, generation]) => ({ hash, legacy: movedLegacy(generation) }))
    const options = { name, generations, retire: !item && row.deleted !== undefined }
    if (!options.retire && !generations.length) return
    assertTeam(team)
    const result = removing ? storage.remove(name, generations, options) : storage.collect(options)
    if (result.removed.length < generations.length && !warnedUnknown.has(name)) {
      warnedUnknown.add(name)
      rt.warn('ds-bot: skill %s retained: unknown-files', name)
    }
    if (!result.removed.length && !result.retired) return
    await skillLedger(ledger => {
      const latest = ledger.names[name]
      for (const hash of result.removed) delete latest.generations[hash]
      if (result.retired && Object.keys(latest.generations).length === 0) delete ledger.names[name]
    }, team)
  }

  function skillsReady() {
    const revision = teamKey()
    if (readiness?.revision === revision) return readiness.run
    if (readyRevision === revision && !retry) return Promise.resolve()
    const team = rt.teamGeneration()
    const run = context.exit(async () => {
      failures.clear()
      retry = false
      const names = Object.keys(library()).filter(name => itemOf(name)?.kind === 'skill')
      if (!canWrite()) return
      try {
        const marker = importedState()
        if (!names.length && !marker && !lstatSync(join(rt.home, 'skills'), { throwIfNoEntry: false })) return
        const storage = getStore()
        const ledger = storage.readLedger()
        const previousHolds = storage.readImportHolds().items
        const heldImports = Object.assign(Object.create(null), previousHolds)
        const all = [...new Set([...names, ...Object.keys(ledger.names)])].sort()
        for (const name of all) {
          assertTeam(team)
          if (!skillName(name)) {
            if (marker) heldImports[name] = skillRecordId(itemOf(name))
            continue
          }
          try { await skillQueue(name, held => reconcileName(held, name, team, marker, heldImports)) } catch (error) {
            if (!rt.sameTeam(team)) return
            const code = storeCode(error)
            if (error instanceof SkillFilesChanged) setFailure(name, 'changed')
            else {
              setFailure(name, 'store-failed', code)
              retry = true
              rt.warn('ds-bot: skill %s held: %s', name, code)
            }
          }
        }
        assertTeam(team)
        updateImportHolds(team, items => {
          let changed = false
          for (const [name, id] of Object.entries(items)) {
            const item = itemOf(name)
            if (item?.kind === 'skill' && id === skillRecordId(item)) continue
            delete items[name]
            changed = true
          }
          for (const [name, id] of Object.entries(heldImports)) {
            const item = itemOf(name)
            if (Object.hasOwn(previousHolds, name) && previousHolds[name] === id) continue
            if (item?.kind !== 'skill' || id !== skillRecordId(item) || own(items, name) === id) continue
            Object.defineProperty(items, name, { value: id, enumerable: true, writable: true, configurable: true })
            changed = true
          }
          return changed
        })
        if (marker && !retry) {
          // Persist a newly created skills root before removing the import marker.
          syncContainingDirectory(importPath)
          assertTeam(team)
          unlinkSync(importPath)
          syncContainingDirectory(importPath)
        }
        if (retry || !rt.teamHealth()?.present || !rt.capabilitiesIntact()
          || [...failures.values()].some(({ state }) => ['store-failed', 'malformed', 'newer-format'].includes(state))) return
        for (const name of all.filter(skillName)) {
          await skillQueue(name, () => collectName(name, team))
        }
        writeStore(team, storage => {
          storage.sweepStaging({ olderThanMs: 30 * 60_000 })
          storage.sweepTemps(60 * 60_000)
        })
      } catch (error) {
        if (!rt.sameTeam(team)) return
        retry = true
        for (const name of names) setFailure(name, 'store-failed', storeCode(error))
      }
    }).finally(() => {
      if (readiness?.run !== run) return
      readyRevision = revision
      readiness = undefined
    })
    readiness = { revision, run }
    return run
  }

  const statusKeys = {
    changed: 'skill.changed-elsewhere', 'store-failed': 'skill.store-failed', malformed: 'skill.record-invalid',
  }
  const status = (name, state, extra = {}) => ({
    state, key: statusKeys[state], deliverable: false, reportOnly: false,
    ...(reservedCommandOf(name) ? { reservedName: true } : {}), ...extra,
  })
  function blockedStatus(name, item, generation) {
    if (item.suspended) return status(name, 'suspended')
    if (item.check?.verdict !== 'block') return
    const reportOnly = item.source.kind === 'bot' && generation?.state === 'committed'
      && (generation.via === 'bot' || (generation.via === 'move' && item.source.moved === true && provenance(item) === 'bot'))
    if (!reportOnly) return status(name, 'suspended')
  }
  function loadGeneration(name, { delivery = false } = {}) {
    const validName = skillName(name)
    const item = typeof name === 'string' ? itemOf(name) : undefined
    if (item?.kind !== 'skill') return { status: status(name, validName ? 'unchecked' : 'malformed') }
    const failed = failures.get(name)
    if (failed) return { status: status(name, failed.state, { why: failed.why }) }
    try {
      if (importedState()) return { status: status(name, 'unchecked') }
      const storage = getStore()
      if (storage.bound().ok && hasImportHold(storage.readImportHolds().items, name, item)) {
        return { status: status(name, 'changed', { why: 'import' }) }
      }
      if (!validName || item.name !== name) return { status: status(name, 'malformed') }
      if (item.skillFormat > 1) return { status: status(name, 'newer-format') }
      if (!storage.bound().ok && storage.bound().code === 'root-absent') return { status: status(name, 'unchecked') }
      if (!storage.bound().ok) return { status: status(name, 'store-failed', { why: storage.bound().code }) }
      if (preRfc(item)) return { status: status(name, 'unchecked') }
      const ledger = storage.readLedger()
      const row = own(ledger.names, name)
      const generation = own(row?.generations ?? {}, item.hash)
      if (!(rt.validSkillRecord ?? validSkillRecord)(item, generation)) return { status: status(name, 'malformed') }
      if (item.mirror !== skillMirror(item)) return { status: status(name, 'changed') }
      const held = delivery && blockedStatus(name, item, generation)
      const entries = storage.read(name, item.hash, item.files, { legacyBody: movedLegacy(generation), capture: !held })
      if (held) return { status: held }
      const md = entries.find(entry => entry.path === 'SKILL.md').bytes
      const skillMd = rt.parseSkillMd?.(md) ?? textSkillFields(md)
      if (skillMd.ok === false || skillMd.name !== name) return { status: status(name, 'changed') }
      return { snapshot: { name, hash: item.hash, entries, skillMd }, generation }
    } catch (error) {
      return { status: error.key === 'skill.store-failed'
        ? status(name, 'store-failed', { why: storeCode(error) })
        : status(name, canWrite() ? 'changed' : 'unchecked') }
    }
  }
  function skillDelivery(name) {
    const { snapshot, status: held, generation } = loadGeneration(name, { delivery: true })
    if (held) return { status: held }
    const result = rt.skillStatus(itemOf(name), snapshot, generation)
    return result.deliverable ? { status: result, snapshot } : { status: result }
  }
  Object.assign(rt, {
    skillCommit, skillQueue, skillLedger, skillsReady, skillDelivery, recordSkillCheck,
    skillGeneration: name => loadGeneration(name).snapshot,
    skillStatus(item, snapshot, generation) {
      if (!snapshot) {
        const result = loadGeneration(item.name, { delivery: true })
        if (result.status) return result.status
        snapshot = result.snapshot
        generation = result.generation
      }
      const held = blockedStatus(item.name, item, generation)
      if (held) return held
      if (snapshot.entries.length > 1) return status(item.name, 'unchecked', { why: 'folder-delivery' })
      return status(item.name, 'unchecked', { deliverable: true, reportOnly: item.check?.verdict === 'block' })
    },
    skillModelText(name) {
      const { snapshot } = skillDelivery(name)
      if (!snapshot) return undefined
      const { description, body } = snapshot.skillMd
      return { hash: snapshot.hash, description, body }
    },
  })
  Object.defineProperty(rt, 'skillStore', { get: getStore, configurable: true })
  return {
    textRequest,
    async recoverDelete(name, team) {
      if (itemOf(name) === undefined && lstatSync(join(rt.home, 'skills'), { throwIfNoEntry: false })) {
        await finishAbsentDelete(name, team, own(getStore().readLedger().names, name))
      }
    },
    deleteSkill(name, authorize, expect) {
      const team = rt.teamGeneration()
      const current = () => {
        const item = itemOf(name)
        if (expect !== undefined && (!expect?.team || !rt.sameTeam(expect.team)
          || item?.kind !== 'skill' || item.kind !== expect.kind || skillRecordId(item) !== expect.id)) throw changes()
        return item
      }
      return skillQueue(name, async () => {
        assertTeam(team)
        const item = current()
        authorize(item)
        const beforeCommit = () => {
          assertTeam(team)
          const latest = current()
          if (expect === undefined && latest !== item) throw changes()
          authorize(latest)
        }
        await skillLedger(ledger => {
          beforeCommit()
          const entry = own(ledger.names, name) ?? (ledger.names[name] = { generations: {} })
          entry.deleting = { at: Date.now(), hash: deletionHash(item), ...(item.skillFormat > 1 ? { preserve: true } : {}) }
        }, team)
        try {
          await saveRecord(name, beforeCommit, undefined, expect?.team)
          await finishDelete(name, team)
        } catch (error) {
          retry = true
          throw error.key ? error : badStore(error)
        }
        // Future formats can be dismissed from the library without interpreting their files.
        if (item.skillFormat > 1) return true
        try { await collectName(name, team, true) } catch (error) {
          rt.warn('ds-bot: skill %s removal deferred: %s', name, storeCode(error))
          retry = true
        }
        return true
      })
    },
  }
}
