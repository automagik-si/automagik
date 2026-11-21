export const CALLER_READS = Object.freeze(['whoami', 'state', 'list-bots', 'get-bot', 'chat', 'earlier'])

const prompting = new Set([
  'send', 'stage-image', 'answer-question', 'view-reply', 'dismiss-question', 'dismiss-view',
  'resume', 'memory-ask', 'learning-answer', 'goal-draft',
])

export function callerEndpoint(role, endpoint) {
  if (role === 'member' || role === 'guest') {
    if (CALLER_READS.includes(endpoint)) return { allow: true }
    if (prompting.has(endpoint)) return {
      allow: false, code: 'bot/refused', reason: 'read-only',
      message: "You can read this Bot's chat; sending, answering and uploading are not open to members and guests yet.",
    }
  }
  return { allow: false, code: 'bot/refused', reason: 'owner-only', message: 'This is not available to you.' }
}
