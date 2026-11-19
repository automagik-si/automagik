// Curated owner-facing recovery copy. Never display raw vendor or process diagnostics.
export const ACCOUNT_RECOVERY_CODE = 'bot/account-recovery'
export const ACCOUNT_RECOVERY_HINT =
  'Bot sign-in recovery is needed. Reset Bot sign-in to start fresh.'

// Whose sign-in is whose (#1399): the Bot account is one per person, kept in the team's home,
// so an installation that uses the same home shares it. The card says so before a change is
// attempted; nobody has to discover it from a refusal.
export const ACCOUNT_SHARING_HINT =
  'Other Automagik installations on this computer may use this same Bot sign-in. A change here changes it for all of them.'

/**
 * The sentence the host wrote for a refused account change, or undefined for anything else.
 * Only `bot/refused` is user copy from the owner route (cli-login.js maps every vendor and
 * process failure to a fixed sentence before it gets here); a private diagnostic, a network
 * error or an internal failure keeps the card's own line instead.
 */
export const accountChangeFailure = error => (
  error?.code === 'bot/refused' && typeof error.message === 'string' && error.message.trim() !== ''
    ? error.message
    : undefined
)

/**
 * The installation label a host names (the DSH profile), as one bounded display line: control
 * characters go, surrounding space goes, and an empty or absent name is undefined so the card
 * leaves the line out rather than showing "unknown". Never a path, an account or a credential.
 */
export const installationNameOf = value => {
  if (typeof value !== 'string') return undefined
  const text = [...value].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join('').trim()
  return text === '' ? undefined : [...text].slice(0, 60).join('')
}
