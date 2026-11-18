// Snapshot ancestry before shutdown can reparent a tool into another session.
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { parseProcStat, processBirth, processState, validBirth } from './process-identity.js'

const BOUND_MS = 1500
let snapshotUntil

// Disposals in one turn share the blocking allowance, including missing birth reads.
export function snapshotBudget(deps = {}) {
  if (snapshotUntil === undefined) {
    snapshotUntil = Date.now() + BOUND_MS
    setImmediate(() => { snapshotUntil = undefined }).unref?.()
  }
  const now = deps.now ?? Date.now
  const remaining = Math.max(0, snapshotUntil - Date.now())
  return treeBudget({ ...deps, until: Math.min(deps.until ?? Infinity, now() + remaining) })
}
const pidOf = pid => Number.isSafeInteger(pid) && pid > 1
const sameBirth = (a, b) => validBirth(a) && validBirth(b) && a.platform === b.platform
  && a.start === b.start && (a.platform !== 'linux' || a.boot === b.boot)
export const supportsTree = platform => platform === 'linux' || platform === 'darwin'

export function treeBudget(deps = {}) {
  const now = deps.now ?? Date.now
  return { ...deps, now, until: Math.min(deps.until ?? Infinity, now() + BOUND_MS) }
}

export function parsePsTable(output) {
  const records = []
  for (const line of output.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const [, pid, ppid, pgid, start] = match
    const birth = { platform: 'darwin', start: start.replace(/\s+/g, ' ') }
    if (!validBirth(birth)) continue
    records.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), birth })
  }
  return records
}

function readTable(deps) {
  const { platform = process.platform, read = readFileSync, list = readdirSync,
    exec = execFileSync, now, until } = deps
  const records = []
  const unreadable = new Set()
  let complete = true
  try {
    if (now() >= until) return { records, complete: false }
    if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      if (now() >= until) return { records, complete: false }
      for (const name of list('/proc')) {
        if (now() >= until) { complete = false; break }
        if (!/^[1-9][0-9]*$/.test(name)) continue
        const pid = Number(name)
        try {
          const stat = parseProcStat(pid, read(`/proc/${pid}/stat`, 'utf8'))
          const birth = { platform, boot, start: stat?.start }
          if (!stat || !validBirth(birth)) {
            unreadable.add(pid)
            complete = false
            continue
          }
          const { ppid, pgid } = stat
          records.push({ pid, ppid, pgid, birth })
        } catch (error) {
          unreadable.add(pid)
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') complete = false
        }
      }
    } else if (platform === 'darwin') {
      const output = exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8', timeout: Math.max(1, until - now()),
        maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' },
      })
      records.push(...parsePsTable(output))
      if (records.length !== output.trim().split('\n').filter(line => line.trim()).length) {
        complete = false
      }
    } else complete = false
  } catch { complete = false }
  if (now() >= until || records.some(record => unreadable.has(record.ppid))) complete = false
  return { records, complete }
}

function bornAfter(child, parent) {
  if (child.platform !== parent.platform) return false
  if (child.platform === 'linux') {
    return child.boot === parent.boot && BigInt(child.start) >= BigInt(parent.start)
  }
  return Date.parse(`${child.start} UTC`) >= Date.parse(`${parent.start} UTC`)
}

export function descendants(rootPid, rootBirth, deps = {}) {
  deps = treeBudget(deps)
  const { platform = process.platform, now, until } = deps
  const unknown = { records: [], complete: false }
  if (!supportsTree(platform) || !pidOf(rootPid) || !validBirth(rootBirth)) return unknown
  const table = readTable(deps)
  const byPid = new Map(table.records.map(record => [record.pid, record]))
  const root = byPid.get(rootPid)
  if (!root || !sameBirth(root.birth, rootBirth)) return unknown
  // The root is still ours after the scan. macOS uses the one table's identity.
  if (now() >= until || (platform === 'linux'
    && !sameBirth(processBirth(rootPid, deps), rootBirth))) return unknown
  const children = new Map()
  for (const record of table.records) {
    if (now() >= until) { table.complete = false; break }
    const parent = byPid.get(record.ppid)
    if (!pidOf(record.pid) || !Number.isSafeInteger(record.pgid) || record.pgid < 0
      || !parent || !bornAfter(record.birth, parent.birth)) continue
    if (!children.has(record.ppid)) children.set(record.ppid, [])
    children.get(record.ppid).push(record)
  }
  const found = []
  const seen = new Set([rootPid])
  const parents = [rootPid]
  for (let i = 0; i < parents.length; i++) {
    for (const record of children.get(parents[i]) ?? []) {
      if (now() >= until) return { records: found, complete: false }
      if (seen.has(record.pid)) continue
      seen.add(record.pid)
      parents.push(record.pid)
      found.push(record)
    }
  }
  return { records: found, complete: table.complete }
}

function readCheckTable(deps) {
  const exec = deps.execAsync ?? execFile
  return new Promise(resolve => {
    try {
      exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8', timeout: 2000,
        maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' },
      }, (error, output) => {
        resolve(error ? [] : parsePsTable(output))
      })
    } catch { resolve([]) }
  })
}

function checks(records, deps, visit) {
  const { platform = process.platform, read = readFileSync, kill = process.kill,
    now, until } = deps
  const states = new Map()
  const present = new Set()
  for (const record of records) {
    if (states.has(record.pid) || present.has(record.pid)) continue
    if (!pidOf(record.pid)) { states.set(record.pid, 'unknown'); continue }
    try { kill(record.pid, 0); present.add(record.pid) } catch (error) {
      states.set(record.pid, error?.code === 'ESRCH' ? 'dead' : 'unknown')
    }
  }
  // Probe every known pid before awaiting the one table read.
  const finish = table => {
    const byPid = new Map(table.map(record => [record.pid, record]))
    let group
    try {
      if (present.size && now() < until) {
        group = platform === 'darwin' ? byPid.get(process.pid)?.pgid
          : parseProcStat(process.pid, read(`/proc/${process.pid}/stat`, 'utf8'))?.pgid
      }
    } catch {}
    return visit({
      group,
      state(record) {
        if (!states.has(record.pid)) {
          const state = now() >= until ? 'unknown' : processState(record.pid, record.birth, {
            probe: () => {},
            identity: pid => platform === 'darwin' ? byPid.get(pid)?.birth
              : processBirth(pid, deps),
          })
          states.set(record.pid, now() >= until ? 'unknown' : state)
        }
        return states.get(record.pid)
      },
    })
  }
  if (present.size && platform === 'darwin') return readCheckTable(deps).then(finish)
  return finish([])
}

function checkBudget(deps) {
  return (deps.platform ?? process.platform) === 'darwin'
    ? { now: Date.now, until: Infinity, ...deps } : treeBudget(deps)
}

export function treeStates(records, deps = {}) {
  deps = checkBudget(deps)
  return checks(records, deps, ({ state }) => records.map(state))
}

export function signalTree(records, signal, deps = {}) {
  deps = checkBudget(deps)
  const { kill = process.kill, agentPgid, now, until } = deps
  return checks(records ?? [], deps, ({ group, state }) => {
    const safe = pid => pidOf(pid) && pid !== process.pid && pid !== group
    const byPid = new Map((records ?? []).map(record => [record.pid, record]))
    const targets = new Map()
    // Pick and deduplicate targets before reading any target's identity.
    for (const record of byPid.values()) {
      if (now() >= until) return
      if (!safe(record.pid)) continue
      const leader = byPid.get(record.pgid)
      const grouped = pidOf(group) && safe(record.pgid) && record.pgid !== agentPgid
        && leader !== undefined && leader.pid === leader.pgid
      const target = grouped ? -record.pgid : record.pid
      if (!targets.has(target)) {
        targets.set(target, { leader: grouped ? leader : record, members: [] })
      }
      targets.get(target).members.push(record)
    }
    const send = (target, record) => {
      if (state(record) !== 'live' || now() >= until) return false
      try { kill(target, signal) } catch { return false }
      return true
    }
    for (const [target, { leader, members }] of targets) {
      if (now() >= until) return
      send(target, leader)
      if (target > 0) continue
      // A member may have left the group. Check its own live identity in this pass too.
      for (const record of members) {
        if (now() >= until) return
        send(record.pid, record)
      }
    }
  })
}
