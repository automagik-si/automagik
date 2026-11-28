// The service can keep additional, explicitly registered specs alongside these.
export const PURPOSES = Object.freeze([
  Object.freeze({ id: 'group-routing', label: 'Group routing', kinds: Object.freeze(['multi-select']),
    defaults: Object.freeze({ tau: 0.5, k: 3, tau0: 0.2, deadlineMs: 2500, sure: 0.8 }) }),
  Object.freeze({ id: 'settings-test', label: 'Settings test', kinds: Object.freeze(['yes-no']),
    defaults: Object.freeze({ tau: 0.5, k: 1, tau0: 0.2, deadlineMs: 5000, sure: 0.8 }) }),
])
