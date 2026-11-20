export function multiuserMode(value) {
  if (value === '1') return 'on'
  return value === undefined || value === '' || value === '0' ? 'off' : 'invalid'
}

export function startupDecision(mode) {
  if (mode === 'off') return { ok: true }
  return {
    ok: false,
    reason: mode === 'on'
      ? 'multiuser is on, but this image does not carry the multiuser adapter yet (RFC 0038 delivery 1 image follow-up)'
      : 'invalid AUTOMAGIK_MULTIUSER (expected 1, 0 or unset)',
  }
}
