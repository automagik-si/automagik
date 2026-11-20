// Bounded states and refusal copy shared by the owner route and the card.
const RECORD_UNREAD = 'The reservation record cannot be read here; nothing was changed.'
export const RESERVATION_MESSAGES = {
  damaged: RECORD_UNREAD,
  unreadable: RECORD_UNREAD,
  unsafe: 'The reservation record has unsafe permissions.',
  'no-instance': 'This installation has no instance id; reservations are off.',
  unsupported: 'This version cannot read the account evidence needed for reservations.',
  'signed-out': 'Sign in to reserve this account.',
  unknown: 'The sign-in could not be read; reservations wait.',
  recovery: 'Recover the Bot sign-in before reserving this account.',
  changed: 'This reservation changed. Look again.',
  unread: 'The account could not be read for reservations. Try again.',
  'not-reservable': 'This account cannot be reserved.',
}
export const RESERVATION_REASONS = {
  'no-organisation': 'Update Claude Code: this version does not name the organisation.',
  'unknown-plan': 'This Codex plan is not known to this version.',
  'not-a-subscription': 'Only a subscription sign-in can be reserved.',
  'no-email': 'The CLI did not show an email for this account.',
}

export function reservationMessage({ state, why }) {
  return (state === 'not-reservable' && Object.hasOwn(RESERVATION_REASONS, why)
    ? RESERVATION_REASONS[why] : RESERVATION_MESSAGES[state])
}
