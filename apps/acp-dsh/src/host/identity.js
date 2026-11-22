import { createHash } from 'node:crypto'

export const IDENTITY_PROVIDERS = Object.freeze(['acp-claude', 'acp-codex'])
export const ROLE_PROMPT_MAX = 16 * 1024 + 128

const named = identity => typeof identity?.name === 'string' && identity.name.trim() !== ''
const roleMarker = /^<role-prompt id="[a-z0-9][a-z0-9-]{0,40}">\n[\s\S]*\n<\/role-prompt>$/

export function rolePromptOf(identity) {
  if (!named(identity)) return { digest: '' }
  const part = identity.rolePrompt
  if (part === undefined) return { digest: '' }
  if (typeof part !== 'string') return { digest: '', refused: 'type' }
  if (Buffer.byteLength(part, 'utf8') > ROLE_PROMPT_MAX) return { digest: '', refused: 'size' }
  if (!roleMarker.test(part)) return { digest: '', refused: 'shape' }
  return { part, digest: createHash('sha256').update(part).digest('hex') }
}

export function identityText(identity, part) {
  if (!named(identity)) return undefined
  const { name, role, instructions } = identity
  return '# Your identity\n'
    + `You are ${name}, a Bot on the user's team.`
    + (role ? ` Your role: ${role}.` : '')
    + (instructions ? `\n\n${instructions}` : '')
    + (part ? `\n\n${part}` : '')
    + '\n\nFor a Bot Browser request, use the browser tools this conversation offers. '
    + 'Never launch Chrome or another browser from a command. '
    + 'When sign-in, payment or verification needs the person, use the offered browser handoff '
    + '(`browser_handoff` when available) and stop until they answer. '
    + 'If you cannot open the page here, ask the Bot named `browse` only when '
    + '`message_bot` is offered '
    + 'and that Bot is on the team. Say when the request was sent, then report the browser outcome '
    + 'when its reply arrives. If the route is unavailable or a call fails, say why.'
}

export function createIdentityReaders(warn) {
  const readers = new Set()
  let registered = false
  return {
    everRegistered: () => registered,
    register(reader) {
      if (typeof reader !== 'function') return () => {}
      registered = true
      const entry = { reader }
      readers.add(entry)
      return () => { readers.delete(entry) }
    },
    read(sessionId) {
      let identity
      for (const { reader } of readers) {
        let found
        try { found = reader(sessionId) } catch {
          warn('a Bot identity reader failed; no identity is sent')
          return undefined
        }
        if (found === undefined) continue
        if (identity !== undefined) {
          warn('competing Bot identities for one Session; no identity is sent')
          return undefined
        }
        identity = found
      }
      return identity
    },
  }
}

export function readIdentity(read, sessionId) {
  try { return read(sessionId) } catch { return undefined }
}
