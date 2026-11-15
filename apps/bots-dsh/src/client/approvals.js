import { t } from './i18n.js'
// Whether an approval waits for the user: for a Bot, in any of its Sessions; for a group,
// from any of its members there. The sidebar, the header and the details panel all read it,
// so a Bot blocked on the user shows the same `alert` everywhere.
export const useApproval = (useWork, match) => (useWork ? useWork(work => (work.approvals ?? []).some(match)) : false)

export const approvalCount = (work, match) => (work?.approvals ?? []).filter(match).length

// Sort a copy so the earliest request names the group, with ties in arrival order.
export function groupApprovals(entries) {
  const keyed = new Map()
  return entries.slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(entry => {
    const key = entry.capabilityKey
    const group = key === undefined ? undefined : keyed.get(key)
    if (group) {
      group.entries.push(entry)
      return undefined
    }
    const first = { key: key ?? entry.id, entries: [entry] }
    if (key !== undefined) keyed.set(key, first)
    return first
  }).filter(Boolean)
}

export function nativeAsk(statusMap, entry) {
  const pending = statusMap.get(entry.sessionId)?.pendingInteraction
  return pending?.kind === 'approval' && typeof pending.answer === 'function' && pending.answerable !== false
    && entry.callId !== undefined && pending.callId === entry.callId && pending.toolName === entry.tool
    // A later ask on the same call (a hard step's escalation) carries another reason.
    && String(pending.reason ?? '') === String(entry.reason ?? '') ? pending : undefined
}

export async function answerGroup(entries, choice, { actions, statusMap }) {
  const snapshot = [...entries]
  const results = await Promise.allSettled(snapshot.map(async entry => {
    if (entry.answerable) await actions.answerApproval(entry.id, choice)
    else {
      const ask = nativeAsk(statusMap, entry)
      if (!ask) return false
      await ask.answer(choice === 'allow' ? 'allowed-once' : 'rejected')
    }
    return true
  }))
  let answered = 0
  let skipped = 0
  for (const result of results) {
    if (result.status === 'rejected') actions.reportError?.(result.reason, 'approval')
    else if (result.value) answered += 1
    else skipped += 1
  }
  return { answered, skipped }
}

export const approvalPlace = (entry, roster) => roster?.roomsById?.[entry.roomId]?.name
  ?? (entry.taskId !== undefined ? roster?.tasks?.[entry.taskId]?.title ?? entry.label : undefined) ?? ''
// Where each ask of a merged card waits, the Bot's own chat named too, so every one is listed.
export const approvalWhere = (entry, roster) => approvalPlace(entry, roster) || (entry.roomId === undefined && entry.taskId === undefined ? t('in its own chat') : '')
// What the ask would do: its command, path or url; for an agent's own call through ACP, which
// has none of those, the reason that names it (acp-dsh), as DSH's own card shows it.
export const approvalDetail = entry => entry.detail?.code || (entry.tool === 'acp_tool' ? String(entry.reason ?? '') : '')
