// Reservation copy shared by the owner card and the turn and image checks.
export const MACHINE_MESSAGES = {
  absent: 'Reservations are not checked across instances here: this machine has no reservations '
    + 'folder.',
  unreadable: 'Reservations are not checked across instances here: this OS user cannot read the '
    + 'reservations folder.',
  'not-set-up': 'Reservations are not checked across instances here: the reservations folder is '
    + "not set up completely. Ask this machine's administrator.",
  unsupported: 'Reservations across instances are not offered on Windows yet.',
  mine: 'Reserved for {label} on this machine.',
  other: 'Also reserved on this machine: {label} (another {vendor} account).',
  refused: 'Reserved for {label} on another instance. Sign in with another account, or ask its '
    + 'owner to make it shared.',
  'no-organisation': 'This sign-in may be the account reserved for {label} on another instance: '
    + 'this Claude Code does not name the organisation. Update Claude Code, or ask the '
    + "reservation's owner to make it shared.",
  'unknown-plan': 'This sign-in may be the account reserved for {label} on another instance: '
    + 'this Codex plan is not known to this version. Update Codex, or ask the '
    + "reservation's owner to make it shared.",
  'unreadable-file': "This account's reservation file on this machine cannot be read, so the "
    + "account is not used here. Ask this machine's administrator to check the reservations "
    + 'folder.',
  owner: 'File owner: {owner}',
  conflict: 'This account is reserved for {label} on another instance.',
  'not-own-file': 'Only the OS user who made this reservation can make it shared. Ask this '
    + "machine's administrator.",
  privacy: "Members of this machine's reservations group could test a guessed email.",
  failed: 'The reservation could not be saved on this machine. Try again.',
}

export const fill = (template, values) => template.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m)

export function machineNotice(state) {
  if (state === 'no-key' || state === 'bad-key') return MACHINE_MESSAGES['not-set-up']
  if (state === 'absent' || state === 'unreadable' || state === 'not-set-up'
    || state === 'unsupported') return MACHINE_MESSAGES[state]
}

export function machineRefusal({ state, why }) {
  if (state === 'refused') return MACHINE_MESSAGES.refused
  if (state === 'ambiguous') return MACHINE_MESSAGES[why]
  if (state === 'unreadable') return MACHINE_MESSAGES['unreadable-file']
}
