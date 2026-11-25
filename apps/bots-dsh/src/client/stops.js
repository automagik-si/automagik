import { t } from './i18n.js'
import { HELD_LINES } from '../shared/held.js'

export const heldText = text => (HELD_LINES.has(text) ? t(text) : text)

export function whyText(why) {
  switch (why) {
    case 'never': return t('approvals are off here, so you were not asked')
    case 'unavailable': return t('it needed your approval, but nothing here could ask you')
    case 'tool': return t('this Bot does not have that tool')
    case 'level': return t('its permission level could not be set here')
    case 'address': return t('the address list blocks that site')
    case 'review': return t('Auto review refused it')
    case 'sandbox': return t('the sandbox blocked it')
    case 'guard': return t('the review guard waits for the reviewer\'s verdict on the plan; you can turn it off in Details')
    case 'guard-request': return t('the review guard waits for the reviewer\'s verdict on a new plan, because another Bot sent a new request; you can turn it off in Details')
    case 'guard-launch': return t('the review guard is on and prevents starting tasks; you can turn it off in Details')
    default: return t('a rule here refused it')
  }
}

export function stopLine(entry) {
  const why = whyText(entry.why)
  return entry.count > 1 ? t('{count} steps did not run: {why}', { count: entry.count, why })
    : entry.child ? t('A subagent step did not run: {why}', { why })
      : entry.tool ? t('{tool} did not run: {why}', { tool: entry.tool, why }) : t('A step did not run: {why}', { why })
}

export const openStops = work => (work?.stops ?? []).filter(entry => entry.open)
export const stopOfCall = (stops, sessionId, callId) => (stops ?? []).find(entry => callId !== undefined && entry.calls?.find(call => call.sessionId === sessionId)?.callId === callId)
