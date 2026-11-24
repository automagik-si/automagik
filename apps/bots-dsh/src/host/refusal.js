// A refusal whose message this code wrote for the user. The /api channel answers only
// an error carrying a `bot/` or `memory/` code by its message; every other error may
// be a provider's (its request or endpoint text) or a file system's (a path), so it is
// answered by kind alone. A deliberate message therefore says so with this helper.
export const refusal = (message, { code = 'bot/refused', cause, reason } = {}) => Object.assign(
  new Error(message, cause === undefined ? undefined : { cause }),
  { code, ...(reason === undefined ? {} : { reason }) },
)
