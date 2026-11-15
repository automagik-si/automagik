import { AgentRun } from '../../src/host/acp.js'

export const CANCELLED = { outcome: { outcome: 'cancelled' } }
export const OPTIONS = [
  { optionId: 'yes', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
  { optionId: 'no', kind: 'reject_once' },
]
export const picked = optionId => ({ outcome: { outcome: 'selected', optionId } })

// A missing answer fails the test rather than leaving its prompt holding the process open.
export async function soon(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the answer did not settle')), 1000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

// The real run, with just its ACP peer replaced by a prompt the test can finish.
export function probe(t, spec = {}) {
  const run = new AgentRun({ name: 'Probe agent', cwd: process.cwd(), ...spec })
  run.sessionId = 'current'
  run.gone = new Promise(() => {})
  let finish
  run.conn = {
    prompt: () => new Promise(resolve => { finish = resolve }),
    forkSession: async () => ({ sessionId: 'forked' }),
    closeSession: async () => ({}),
    cancel: async () => { finish({ stopReason: 'cancelled' }) },
  }
  t.after(() => run.dispose())
  const begin = () => {
    const prompting = run.prompt([{ type: 'text', text: 'go' }])
    const end = finish
    return async () => {
      end({ stopReason: 'end_turn' })
      await soon(prompting)
    }
  }
  const see = (toolCallId, more = {}) => run.onUpdate({ sessionUpdate: 'tool_call', toolCallId, title: `Read ${toolCallId}`, kind: 'read', status: 'pending', ...more })
  const ask = (toolCallId, more = {}) => run.onPermission({ toolCall: { toolCallId }, options: OPTIONS, ...more })
  return { run, begin, see, ask }
}
