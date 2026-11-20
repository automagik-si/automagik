// RFC 0034 delivery 1: DSH and ACP inherit the host environment when they start Bot processes.
export const UNLOCK_ENV = Object.freeze([
  'BW_SESSION',
  'BW_CLIENTID',
  'BW_CLIENTSECRET',
  'BW_PASSWORD',
  'BWS_ACCESS_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'OP_CONNECT_TOKEN',
  'OP_SESSION',
  'VAULT_TOKEN',
  'VAULT_MFA',
  'VAULT_AUTH_GITHUB_TOKEN',
  'PROTON_PASS_PERSONAL_ACCESS_TOKEN',
  'PROTON_PASS_PASSWORD',
  'PROTON_PASS_TOTP',
  'PROTON_PASS_EXTRA_PASSWORD',
  'PROTON_PASS_EXTRA_PASSWORD_FILE',
  'PROTON_PASS_ENCRYPTION_KEY',
])
export const UNLOCK_PREFIXES = Object.freeze(['OP_SESSION_'])

export function isUnlockVariable(name) {
  const upper = name.toUpperCase()
  return UNLOCK_ENV.includes(upper) || UNLOCK_PREFIXES.some(prefix => upper.startsWith(prefix))
}

export function dropUnlockVariables(env = process.env) {
  let dropped = 0
  for (const key of Object.keys(env)) {
    if (!isUnlockVariable(key)) continue
    delete env[key]
    dropped++
  }
  return dropped
}
