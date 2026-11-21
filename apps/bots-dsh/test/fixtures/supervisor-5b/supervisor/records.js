import { compareVersions } from '../lane-verify.js'

const VERSION = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/

/** A release version without its `v` and build metadata, or null. */
export const cleanVersion = value => VERSION.exec(String(value ?? '').trim())?.[1] ?? null

export const RUNNING = new Set(['checking', 'downloading', 'verifying', 'staging', 'switching', 'restarting', 'health', 'rollingBack'])
export const TERMINAL = new Set(['healthy', 'rolledBack', 'notUpdated', 'manualRecovery'])
const ID = /^[A-Za-z0-9_-]{8,64}$/
export const REASON_CODES = Object.freeze([
  'download-failed', 'signature-invalid', 'hash-mismatch', 'not-newer', 'sequence-lower',
  'engines-dsh', 'registry-unreachable', 'listener-unknown', 'stage-failed', 'switch-refused', 'health-failed',
  'rollback-failed', 'supervisor-restarted', 'no-writable-home', 'health-check-finished',
  'profile-npmrc', 'desktop-app', 'no-store', 'store-invalid', 'profile-invalid', 'lane-invalid',
  // Refusals of the owner's start and the plugin's own release of its hold (delivery 5b).
  'self-update-off', 'update-running', 'check-stale', 'team-home-custom', 'request-unanswered', 'notes-unwritable', 'starting-up',
])
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
export const isId = value => typeof value === 'string' && ID.test(value)
export const isVersion = value => typeof value === 'string' && value.trim() === value
  && (cleanVersion(value) !== null || compareVersions(value, value) === 0)
const isSequence = value => Number.isSafeInteger(value) && value >= 0

export const hasBootId = (value, bootIds) => bootIds.some(id => value.includes(id))
export const publicVersion = (value, bootIds) => isVersion(value) && !hasBootId(value, bootIds)
export function isTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false
  const [date] = value.split('T')
  const midnight = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(`${date}T`)
}

export function currentOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { live, kept, lastSequence } = value
  if (kept !== null && !publicVersion(kept?.version, bootIds)) return null
  const firstUse = live === null && kept === null && lastSequence === null
  if (!firstUse && !isSequence(lastSequence)) return null
  if (live !== null && (!publicVersion(live?.version, bootIds) || !isSequence(live.sequence)
    || lastSequence < live.sequence)) return null
  return {
    version: 1,
    live: live === null ? null : { version: live.version, sequence: live.sequence },
    kept: kept === null ? null : { version: kept.version },
    lastSequence,
  }
}

export function supervisorStateOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { bootId, runId } = value
  if (!isId(bootId) || (runId !== null && (!isId(runId) || hasBootId(runId, bootIds)))) return null
  return { bootId, runId }
}

export function runOf(value, bootIds) {
  if (value?.version !== 1) return null
  const { runId, bootId, phase, from, to, reason, startedAt, updatedAt, requestId } = value
  if (!isId(bootId) || !isId(runId) || hasBootId(runId, bootIds)
    || (requestId !== undefined && (!isId(requestId) || hasBootId(requestId, bootIds)))
    || (!RUNNING.has(phase) && !TERMINAL.has(phase))
    || (from !== null && !publicVersion(from, bootIds)) || (to !== null && !publicVersion(to, bootIds))
    || (reason !== null && (!REASON_CODES.includes(reason) || hasBootId(reason, bootIds)))
    || !isTimestamp(startedAt) || hasBootId(startedAt, bootIds)
    || !isTimestamp(updatedAt) || hasBootId(updatedAt, bootIds)) return null
  return { version: 1, runId, bootId, phase, from, to, reason, startedAt, updatedAt,
    ...(requestId === undefined ? {} : { requestId }),
  }
}
