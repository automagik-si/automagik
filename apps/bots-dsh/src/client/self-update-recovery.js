import { t } from './i18n.js'

const stateText = { pending: 'Pending', resumed: 'Resumed', failed: 'Could not resume' }
const kindText = { turn: 'Turn', input: 'Queued input', delivery: 'Queued delivery' }

export function recoveryDetails(run, recovery) {
  if (!recovery || recovery.runId !== run.runId || recovery.requestId !== run.requestId) {
    return { message: t('Work recovery results are not available yet.') }
  }
  const { items, omitted, complete, inventoryUnconfirmed } = recovery
  const message = inventoryUnconfirmed ? t('Work recovery is unconfirmed because the saved notes could not be read.') : undefined
  if (complete && items.length === 0 && !omitted) {
    return { message: message ?? t('There was no stopped work to recover.') }
  }
  return {
    message,
    items: items.map(item => ({
      sessionId: item.sessionId,
      text: t('{name} ({kind}) · {state}', {
        name: item.name, kind: t(kindText[item.kind]), state: t(stateText[item.state]),
      }),
    })),
    truncation: omitted && t('More work items than can be shown here ({pending} pending, {resumed} resumed, {failed} could not resume, {unconfirmed} unconfirmed).', {
      unconfirmed: 0, ...omitted,
    }),
  }
}
