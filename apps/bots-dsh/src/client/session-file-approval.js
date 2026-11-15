// Presentation only: the ACP host owns the native request and its nonce. Reuse the existing
// question lifetime and shared approval card; neither a tool policy nor Always can grant it.
const ALLOW = 'Allow for this chat session'
export function selectSessionFileApproval(pending) {
  if (pending?.kind !== 'question' || pending.questions?.length !== 1) return null
  const item = pending.questions[0]
  const intent = item.intent
  if (!/^acp-session-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) ||
      intent?.kind !== 'approval' || intent.approve !== ALLOW || intent.reject !== 'Reject' || intent.always !== undefined ||
      item.multiSelect !== undefined || typeof item.detail !== 'string' || item.detail === '' ||
      item.options?.length !== 2 || item.options[0]?.label !== ALLOW || item.options[1]?.label !== 'Reject') return null
  return { pending, item }
}

export function SessionFileApproval({ matched: { pending, item }, renderFactorySlot }) {
  const answer = label => pending.answer({ answers: [{ id: item.id, selected: [label] }] })
  return renderFactorySlot('conversation.approval.card', {
    requestKey: pending.key, title: item.question, description: item.detail,
    allowLabel: ALLOW,
    canAnswer: () => pending.snapshot().channel !== 'none' && !pending.snapshot().closed,
    onAllow: () => answer(ALLOW), onReject: () => answer('Reject'),
  })
}
