// R3's private record in the team home. In R4 a local claim can be promoted only from one
// observation that supplies both the matching local-key exact and the machine-key digests.
// That requires an additive two-key read in ACP. Two independent reads never promote a claim;
// a failed read or a conflict leaves the local claim intact.
import { codexPlanClass } from '../shared/codex-plan-classes.js'
import {
  DIGEST, TOKEN, cleanLabel, validDate, validInstanceId, validLabel,
  RESERVATION_REASONS, reservationMessage,
} from '../shared/account-reservations.js'
import { fill, MACHINE_MESSAGES } from '../shared/machine-reservations.js'

export const RESERVATION_FILE = 'bot-account-reservations.json'
const VENDORS = { 'acp-claude': 'claude', 'acp-codex': 'codex' }
const REF = /^[A-Za-z0-9_-]{1,64}$/
const OFFER_MS = 10 * 60_000
const MAX_OFFERS = 20
const LABEL_HINT = 'Give the project a name, up to 60 characters.'
const BAD_REQUEST = 'This reservation request is no longer valid. Look again.'
const SAVE_FAILED = 'The reservation could not be saved. Try again.'
const READ_ONLY = 'This window cannot change the Bot team.'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const validClass = value => value === 'personal' || value === 'workspace'
const goodRecord = record => record.state === 'absent' || record.state === 'ok'
const unavailable = state => ({ state })
const refusal = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })
const refuse = view => { throw refusal(reservationMessage(view), `bot/reservation-${view.state}`) }
const changed = () => refuse(unavailable('changed'))

function validClaim(id, claim) {
  const keys = ['vendor', 'exact', 'loose', 'instance', 'label', 'at', 'rev']
  if (claim?.vendor === 'codex') keys.push('class')
  return fields(claim, keys) && (claim.vendor === 'claude' || (claim.vendor === 'codex' && validClass(claim.class)))
    && matches(DIGEST, claim.exact) && matches(DIGEST, claim.loose) && id === `${claim.vendor}:${claim.exact}`
    && validInstanceId(claim.instance) && validLabel(claim.label)
    && validDate(claim.at) && matches(TOKEN, claim.rev)
}

async function observe(service, provider, key, machineKey) {
  if (typeof service?.accountEvidence !== 'function') return unavailable('unsupported')
  let seen
  try {
    const options = machineKey ? { key, keys: [machineKey] } : { key }
    seen = await service.accountEvidence(provider, options)
  } catch (error) {
    return unavailable(error?.code === 'acp-account/unverified-login' ? 'recovery' : 'unread')
  }
  if (seen?.id !== provider) return unavailable('changed')
  if (seen.supported === false) return unavailable('unsupported')
  if (seen.recoveryRequired === true) return unavailable('recovery')
  if (seen.signedIn === false) return unavailable('signed-out')
  if (seen.signedIn !== true) return unavailable('unknown')
  if (seen.outcome === 'none' || seen.outcome === 'ambiguous') {
    const why = typeof seen.why === 'string' && Object.hasOwn(RESERVATION_REASONS, seen.why) ? seen.why : undefined
    return { state: 'not-reservable', ...(why === undefined ? {} : { why }) }
  }
  if (seen.outcome === 'changed') return unavailable('changed')
  if (seen.outcome !== 'complete') return unavailable('unread')
  const vendor = VENDORS[provider]
  if (seen.reservable !== true || seen.vendor !== vendor || !matches(REF, seen.ref) || seen.ref === 'unknown'
    || !matches(DIGEST, seen.exact) || !matches(DIGEST, seen.loose)
    || (vendor === 'codex' && !validClass(seen.class))) return unavailable('changed')
  const machine = seen.digests?.[0]
  if (machineKey && (!Array.isArray(seen.digests) || seen.digests.length !== 1
    || !matches(DIGEST, machine?.exact) || !matches(DIGEST, machine?.loose))) {
    return unavailable('changed')
  }
  return {
    ...(machineKey ? { machine: { exact: machine.exact, loose: machine.loose } } : {}),
    state: 'complete', vendor, ref: seen.ref, exact: seen.exact, loose: seen.loose,
    ...(vendor === 'codex' ? { class: seen.class } : {}),
  }
}

function coherent(account, provider, evidence) {
  return account?.id === provider && account.signedIn === true && account.ref === evidence.ref
    && (provider !== 'acp-codex' || codexPlanClass(account.account?.plan) === evidence.class)
}

export function createAccountReservations(rt, {
  path, fs, random, decodeKey, instanceId, now = Date.now, pid, machine,
}) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  const offers = new Map()
  const handles = new Map()
  const claimIds = new Map()
  const lastMachine = new Map()
  const machineHandles = new Map()
  let tail = Promise.resolve()
  let offerKey, activeKey, lastState
  let keyEpoch = 0

  const currentInstance = () => {
    const id = instanceId()
    return validInstanceId(id) ? id : undefined
  }
  const canWrite = () => rt.holdsLock() === true && rt.readOnly() === undefined
  const requireWriter = () => { if (!canWrite()) throw refusal(READ_ONLY, 'bot/read-only') }
  const sameFolder = (a, b) => b?.state === 'ready' && a.dir === b.dir
    && a.key.every((byte, i) => byte === b.key[i])
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

  function machineFailure(result) {
    if (result.conflict) {
      throw refusal(fill(MACHINE_MESSAGES.conflict, result.conflict), 'bot/reservation-conflict')
    }
    const code = result.refused
    if (code === 'changed' || code === 'absent' || code === 'other-instance' || result.mine) {
      changed()
    }
    const messageId = {
      'not-own-file': 'not-own-file', unreadable: 'unreadable-file', 'not-writable': 'not-set-up',
    }[code]
    if (messageId) throw refusal(MACHINE_MESSAGES[messageId], `bot/reservation-${messageId}`)
    throw refusal(MACHINE_MESSAGES.failed, 'bot/reservation-machine-failed')
  }
  const unsafeStat = info => !info.isFile() || (info.mode & 0o077) !== 0
  function read() {
    let info
    try { info = fs.lstatSync(path) } catch (error) {
      return unavailable(error?.code === 'ENOENT' ? 'absent' : 'unreadable')
    }
    if (unsafeStat(info)) return unavailable('unsafe')

    let bytes
    try {
      const fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      try {
        const opened = fs.fstatSync(fd)
        if (unsafeStat(opened)) return unavailable('unsafe')
        if (opened.dev !== info.dev || opened.ino !== info.ino) return unavailable('unreadable')
        bytes = fs.readFileSync(fd)
      } finally { fs.closeSync(fd) }
    } catch (error) {
      return unavailable(error?.code === 'ELOOP' ? 'unsafe' : 'unreadable')
    }

    try {
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const record = JSON.parse(source)
      if (fields(record, ['version', 'key', 'claims']) && record.version === 1 && object(record.claims)
        && matches(DIGEST, record.key) && decodeKey(record.key).length === 32
        && Object.entries(record.claims).every(([id, claim]) => validClaim(id, claim))) {
        return { state: 'ok', key: record.key, claims: record.claims, source }
      }
    } catch {}
    return unavailable('damaged')
  }

  function keyOf(record, forOffer = false) {
    if (record.state === 'absent' && forOffer) offerKey ??= random(32, 'base64url')
    const key = record.state === 'ok' ? record.key : record.state === 'absent' ? offerKey : undefined
    // Promotion of the same key leaves other offers from the empty record valid. Losing a
    // persisted key invalidates them even if it was originally this process's offer key.
    if (activeKey !== key || (lastState === 'ok' && record.state === 'absent')) {
      offers.clear()
      keyEpoch++
    }
    activeKey = key
    lastState = record.state
    return key
  }

  function write(before, key, claims, instance) {
    let temp
    try {
      const pending = `${path}.${pid}.${random(8, 'hex')}.tmp`
      const fd = fs.openSync(pending, 'wx', 0o600)
      temp = pending
      try {
        fs.fchmodSync(fd, 0o600)
        fs.writeFileSync(fd, `${JSON.stringify({ version: 1, key, claims }, null, 2)}\n`)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      const latest = read()
      if (!goodRecord(latest)) refuse(latest)
      if (latest.state !== before.state || latest.source !== before.source || currentInstance() !== instance) changed()
      requireWriter()
      fs.renameSync(temp, path)
      temp = undefined
    } catch (error) {
      if (error?.code === 'bot/read-only' || (typeof error?.code === 'string' && error.code.startsWith('bot/reservation-'))) throw error
      throw refusal(SAVE_FAILED)
    } finally {
      if (temp !== undefined) {
        try { fs.unlinkSync(temp) } catch {}
      }
    }
  }

  function claimIdOf(id) {
    if (!claimIds.has(id)) {
      const handle = random(16, 'base64url')
      claimIds.set(id, handle)
      handles.set(handle, id)
    }
    return claimIds.get(id)
  }

  function pruneOffers(time) {
    for (const [offerId, offer] of offers) if (offer.expires <= time) offers.delete(offerId)
  }

  function makeOffer(provider, evidence, record, instance, key) {
    const time = now()
    pruneOffers(time)
    while (offers.size >= MAX_OFFERS) offers.delete(offers.keys().next().value)
    const offerId = random(16, 'base64url')
    offers.set(offerId, {
      ...evidence, provider, instance, key, keyEpoch, expires: time + OFFER_MS,
      absent: record.state === 'absent', seen: record.claims?.[`${evidence.vendor}:${evidence.exact}`]?.rev ?? 'absent',
    })
    return { offerId }
  }

  function view(provider, record, evidence, instance, key, hidden) {
    if (!goodRecord(record)) return { state: record.state, claims: [] }
    const vendor = VENDORS[provider]
    const { state, why } = evidence
    const current = state === 'complete' && instance !== undefined ? evidence.exact : undefined
    const claims = []
    for (const [id, claim] of Object.entries(record.claims ?? {})) {
      if (claim.vendor !== vendor || hidden?.has(id)) continue
      claims.push({
        claimId: claimIdOf(id), label: claim.label, current: claim.exact === current,
        mine: claim.instance === instance, rev: claim.rev,
      })
    }
    return {
      state: state === 'complete' && instance === undefined ? 'no-instance' : state, claims,
      ...(why === undefined ? {} : { why }),
      ...(state === 'complete' && evidence.class !== undefined ? { scope: evidence.class } : {}),
      ...(current === undefined ? {} : { offer: makeOffer(provider, evidence, record, instance, key) }),
    }
  }

  function removeLocal(record, id, instance) {
    const claims = { ...record.claims }
    delete claims[id]
    write(record, record.key, claims, instance)
    return { ...record, claims }
  }

  function rememberMachine(provider, ready, files, seen, instance, record) {
    const old = lastMachine.get(provider) ?? []
    const hidden = new Set()
    const next = files.map(file => {
      const prior = old.find(handle => machineHandles.get(handle)?.exact === file.exact)
      const previous = machineHandles.get(prior)
      const same = previous && sameFolder(previous.ready, ready) && previous.instance === instance
        && sameFile(previous, file)
      const machineId = same ? prior : random(16, 'base64url')
      const current = file.exact === seen.machine?.exact
      const vendor = VENDORS[provider]
      const localId = current ? `${vendor}:${seen.exact}` : same ? previous.localId : undefined
      if (record.claims?.[localId]?.instance === instance && localId) hidden.add(localId)
      machineHandles.set(machineId, {
        ...file, provider, vendor, ready, instance, localId, current,
      })
      return machineId
    })
    for (const id of old) if (!next.includes(id)) machineHandles.delete(id)
    lastMachine.set(provider, next)
    return hidden
  }

  function machineClaims(provider) {
    return (lastMachine.get(provider) ?? []).flatMap(machineId => {
      const claim = machineHandles.get(machineId)
      if (!claim) return []
      const { label, current, owner } = claim
      return [{ machineId, label, current, owner }]
    })
  }

  function reserveMachine(ready, seen, instance, label) {
    const { vendor, class: plan } = seen
    return machine.reserve(ready, {
      vendor, ...seen.machine, ...(plan === undefined ? {} : { class: plan }), instance, label,
    })
  }

  async function list(service, provider, account, { recoveryRequired = false, unread = false } = {}) {
    const folder = machine?.open()
    const ready = folder?.state === 'ready' && service?.reservationEvidence >= 2
      ? folder : undefined
    const before = read()
    const probe = goodRecord(before) && !recoveryRequired && !unread
      && typeof service?.accountEvidence === 'function'
    const key = keyOf(before, probe)
    const epoch = keyEpoch
    const instance = currentInstance()
    let seen = probe ? await observe(service, provider, decodeKey(key), ready?.key)
      : unavailable(recoveryRequired ? 'recovery' : unread ? 'unread' : 'unsupported')
    let latest = probe ? read() : before
    if (probe && (keyOf(latest) !== key || epoch !== keyEpoch
      || (seen.state === 'complete' && !coherent(account, provider, seen)))) {
      seen = unavailable('changed')
    }
    const vendor = VENDORS[provider]
    let files = []
    if (ready && instance !== undefined && instance === currentInstance()
      && sameFolder(ready, machine.open())) {
      files = machine.listOwn(ready, vendor, instance)
      const localId = `${vendor}:${seen.exact}`
      const claim = latest.claims?.[localId]
      if (seen.machine && claim?.instance === instance && canWrite()) {
        await enqueue(() => {
          const record = read()
          if (!canWrite() || currentInstance() !== instance || record.key !== key
            || record.claims?.[localId]?.rev !== claim.rev) return
          const current = machine.open()
          if (!sameFolder(ready, current)) return
          const own = machine.listOwn(current, vendor, instance)
            .some(file => file.exact === seen.machine.exact)
          const result = own ? { mine: true } : reserveMachine(current, seen, instance, claim.label)
          if (result.created || result.mine) {
            try { removeLocal(record, localId, instance) } catch {}
          }
        })
        latest = read()
        if (sameFolder(ready, machine.open())) files = machine.listOwn(ready, vendor, instance)
        else files = []
      }
    }
    const hidden = rememberMachine(provider, ready, files, seen, instance, latest)
    return view(provider, latest, seen, currentInstance(), key, hidden)
  }

  function enqueue(fn) {
    const result = tail.then(fn)
    tail = result.catch(() => {})
    return result
  }

  const reserve = (service, payload) => enqueue(async () => {
    requireWriter()
    const rename = fields(payload, ['offerId', 'label', 'claimId', 'rev'])
    const machineRename = fields(payload, ['offerId', 'label', 'machineId'])
    if ((!rename && !machineRename && !fields(payload, ['offerId', 'label']))
      || !matches(TOKEN, payload.offerId)
      || (rename && (!matches(TOKEN, payload.claimId) || !matches(TOKEN, payload.rev)))
      || (machineRename && !matches(TOKEN, payload.machineId))) {
      throw refusal(BAD_REQUEST, 'bot/invalid')
    }
    const label = typeof payload.label === 'string' && payload.label.length <= 4096 ? cleanLabel(payload.label) : ''
    if (!validLabel(label)) throw refusal(LABEL_HINT, 'bot/invalid')
    const instance = currentInstance()
    if (instance === undefined) refuse(unavailable('no-instance'))
    const before = read()
    const key = keyOf(before)
    if (!goodRecord(before)) refuse(before)
    pruneOffers(now())
    const offer = offers.get(payload.offerId)
    const sameKey = record => record.state === 'absent' ? offer.absent : record.key === offer.key
    if (offer === undefined || offer.key !== key || offer.keyEpoch !== keyEpoch
      || offer.instance !== instance || !sameKey(before)) changed()

    const folder = machine?.open()
    const ready = folder?.state === 'ready' ? folder : undefined
    if (ready && !(service?.reservationEvidence >= 2)) refuse(unavailable('unsupported'))
    if (!ready && machineRename) changed()
    const seen = await observe(service, offer.provider, decodeKey(offer.key), ready?.key)
    requireWriter()
    const record = read()
    keyOf(record)
    if (!goodRecord(record)) refuse(record)
    if (offer.keyEpoch !== keyEpoch || !sameKey(record) || offer.expires <= now()
      || currentInstance() !== instance) changed()
    if (seen.state !== 'complete') refuse(seen)
    if (seen.ref !== offer.ref || seen.exact !== offer.exact || seen.class !== offer.class) changed()

    const id = `${offer.vendor}:${offer.exact}`
    const claim = record.claims?.[id]
    if ((claim?.rev ?? 'absent') !== offer.seen) changed()
    if (claim !== undefined && claim.instance !== instance) {
      throw refusal(`This account is reserved for ${claim.label} by another installation that shares this team.`)
    }
    if (!machineRename && (claim === undefined ? rename
      : !rename || handles.get(payload.claimId) !== id || payload.rev !== claim.rev)) changed()
    if (ready) {
      const current = machine.open()
      if (!sameFolder(ready, current)) changed()
      if (offer.machine && offer.machine.exact !== seen.machine.exact) changed()
      if (machineRename) {
        const handle = machineHandles.get(payload.machineId)
        if (!handle || handle.instance !== instance || handle.provider !== offer.provider
          || !sameFolder(handle.ready, current) || handle.exact !== seen.machine.exact) changed()
        const result = machine.relabel(current, {
          vendor: seen.vendor, exact: handle.exact, instance, label, expect: handle,
        })
        if (!result.ok) machineFailure(result)
        machineHandles.delete(payload.machineId)
      } else {
        const result = reserveMachine(current, seen, instance, label)
        if (!result.created && !(rename && result.mine)) machineFailure(result)
        if (rename) {
          if (result.mine) {
            const updated = machine.relabel(current, {
              vendor: seen.vendor, exact: seen.machine.exact, instance, label, expect: result.mine,
            })
            if (!updated.ok) machineFailure(updated)
          }
          try { removeLocal(record, id, instance) } catch {}
        }
      }
      offers.delete(payload.offerId)
      return view(offer.provider, read(), seen, instance, key, new Set([id]))
    }
    const claims = {
      ...record.claims,
      [id]: {
        vendor: seen.vendor, exact: seen.exact, loose: seen.loose,
        ...(seen.class === undefined ? {} : { class: seen.class }),
        instance, label, at: new Date(now()).toISOString(), rev: random(16, 'base64url'),
      },
    }
    write(record, offer.key, claims, instance)
    offers.delete(payload.offerId)
    const persisted = { state: 'ok', key: offer.key, claims }
    keyOf(persisted)
    return view(offer.provider, persisted, seen, instance, offer.key)
  })

  const release = payload => enqueue(() => {
    requireWriter()
    if (fields(payload, ['machineId']) && matches(TOKEN, payload.machineId)) {
      const handle = machineHandles.get(payload.machineId)
      const instance = currentInstance()
      if (instance === undefined) refuse(unavailable('no-instance'))
      const ready = machine?.open()
      if (!handle || handle.instance !== instance || !sameFolder(handle.ready, ready)) changed()
      const record = read()
      if (!goodRecord(record)) refuse(record)
      const localId = handle.localId ?? `${handle.vendor}:${handle.exact}`
      if (record.claims?.[localId]?.instance === instance) removeLocal(record, localId, instance)
      const result = machine.makeShared(ready, { ...handle, instance, expect: handle })
      if (!result.ok) machineFailure(result)
      machineHandles.delete(payload.machineId)
      return { state: 'unknown', claims: [] }
    }
    if (!fields(payload, ['claimId', 'rev']) || !matches(TOKEN, payload.claimId) || !matches(TOKEN, payload.rev)) {
      throw refusal(BAD_REQUEST, 'bot/invalid')
    }
    const instance = currentInstance()
    if (instance === undefined) refuse(unavailable('no-instance'))
    const record = read()
    keyOf(record)
    if (!goodRecord(record)) refuse(record)
    const id = handles.get(payload.claimId)
    const claim = record.claims?.[id]
    if (claim === undefined || claim.rev !== payload.rev || claim.instance !== instance) changed()
    const claims = { ...record.claims }
    delete claims[id]
    write(record, record.key, claims, instance)
    handles.delete(payload.claimId)
    claimIds.delete(id)
    return view(`acp-${claim.vendor}`, { ...record, claims }, unavailable('unknown'), instance, record.key)
  })

  return { list, reserve, release, machineClaims, idle: () => tail }
}
