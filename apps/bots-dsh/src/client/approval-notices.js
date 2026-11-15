import { approvalDetail, approvalPlace } from './approvals.js'
import { openStops, stopLine } from './stops.js'
import { t } from './i18n.js'

// A system notification for each approval that starts waiting while this window is in
// the background or shows another conversation. Only where the platform already allows
// notifications: Omni never asks for the permission.
export function noticeApprovals({ work, roster, shownSession, openSession, since = Date.now() }) {
  const told = new Set()
  const stopsTold = new Set()
  const notify = () => {
    const snapshot = work.getSnapshot()
    const approvals = snapshot.approvals ?? []
    const stops = openStops(snapshot)
    for (const id of stopsTold) {
      if (!(snapshot.stops ?? []).some(entry => entry.id === id)) stopsTold.delete(id)
    }
    for (const id of told) {
      if (!approvals.some(entry => entry.id === id)) told.delete(id)
    }
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    for (const entry of approvals) {
      if (told.has(entry.id)) continue
      told.add(entry.id)
      // Waiting before this window opened is no news: the sidebar shows it.
      if ((entry.at ?? 0) < since) continue
      const place = entry.roomId ?? entry.ownerSessionId ?? entry.sessionId
      if (document.visibilityState === 'visible' && shownSession() === place) continue
      const team = roster.getSnapshot()
      const { byId } = team
      const note = new Notification(t('{name} is waiting for your approval', { name: byId[entry.botId]?.name ?? t('A Bot') }), {
        body: [approvalPlace(entry, team), entry.tool === 'keep_working' ? t('Let it keep working?') : entry.child ? t('A subagent wants to use {tool}', { tool: entry.tool }) : entry.tool, approvalDetail(entry).slice(0, 120)].filter(Boolean).join(' · '),
        tag: `omni-ui-approval-${entry.id}`,
      })
      note.onclick = () => {
        window.focus()
        // A task's approval is answered in the task itself.
        openSession(entry.taskId ?? entry.roomId ?? entry.botId)
        note.close()
      }
    }
    for (const entry of stops) {
      if (stopsTold.has(entry.id)) continue
      stopsTold.add(entry.id)
      if ((entry.at ?? 0) < since) continue
      const drawsHere = entry.roomId !== undefined ? entry.inRound === true : entry.calls?.some(call => call.sessionId === entry.sessionId)
      if (drawsHere && document.visibilityState === 'visible' && shownSession() === (entry.roomId ?? entry.sessionId)) continue
      const { byId, roomsById } = roster.getSnapshot()
      const note = new Notification(t('{name} stopped on a permission', { name: byId[entry.botId]?.name ?? t('A Bot') }), {
        body: [roomsById[entry.roomId]?.name ?? entry.label, stopLine(entry)].filter(Boolean).join(' · '),
        tag: `omni-ui-stop-${entry.id}`,
      })
      note.onclick = () => {
        window.focus()
        openSession(entry.taskId ?? entry.roomId ?? entry.botId)
        note.close()
      }
    }
  }
  notify()
  return work.subscribe(notify)
}
