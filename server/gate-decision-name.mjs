// The gate decision socket's name rule, with no imports: the image entrypoint pins the name in DSH's
// environment and must not load the gate's signer (or node:child_process) to do it.
export const DEFAULT_DECISION_SOCKET = 'automagik-gate-decision'
export function decisionSocketName(name = DEFAULT_DECISION_SOCKET) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error('Invalid gate decision socket name')
  }
  return name
}
