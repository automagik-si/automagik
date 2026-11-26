import { verifiedWindow } from './desktop-window.js'

const desks = new WeakMap()

// The first desk installed for a runtime is the only one allowed to issue its tickets.
export function bindTicketDesk(rt, desk) {
  if (desk !== undefined && !desks.has(rt)) desks.set(rt, desk)
  return desks.get(rt)
}

export function createTicketDesk(connection) {
  const tickets = new WeakMap()
  const digest = () => /^[0-9a-f]{64}$/.test(process.env.AUTOMAGIK_WINDOW_DIGEST ?? '')
  const admission = () => typeof connection?.admit === 'function'
    && connection.browserPeer !== undefined

  function isPerson(request) {
    if (verifiedWindow(request)) return true
    if (!admission()) return false
    try {
      const admitted = connection.admit(request)
      return admitted?.peer !== undefined && admitted.peer === connection.browserPeer
    } catch {
      return false
    }
  }

  function mint(request, decoded) {
    const { id, offer } = decoded ?? {}
    if (typeof id !== 'string' || typeof offer !== 'string' || !isPerson(request)) return
    const ticket = Object.freeze({})
    tickets.set(ticket, { id, offer })
    return ticket
  }

  function spend(ticket) {
    const held = tickets.get(ticket)
    tickets.delete(ticket)
    return held
  }

  return {
    mint,
    desk: Object.freeze({
      spend, voidTicket: ticket => tickets.delete(ticket),
      available: () => digest() || admission(),
    }),
  }
}
