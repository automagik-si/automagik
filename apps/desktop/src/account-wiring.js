// The sign-in account's construction, kept out of main.js so the off setting is executable in a
// test: with the setting off or incomplete, no secure-token store is created and no flow exists,
// so nothing reads safeStorage, binds a port or opens a browser. main.js passes Electron's
// safeStorage, the app's userData folder, fetch and the system browser; tests pass fakes.
//
// This is the only place the store is handed safeStorage. account.js holds the session and
// sign-in.js is the protocol; neither knows Electron.
import { createAccount } from './account.js'
import { createSignInFlow } from './sign-in.js'
import { createTokenStore } from './secure-tokens.js'

/**
 * Build the account for `settings` (sign-in.js readSignInSettings' answer). Returns
 * `{ account, store, flow }`; `store` and `flow` are null unless the setting is on, complete,
 * and both the store and the flow could be made. `account.start()` is the caller's, after app
 * ready. A construction failure is logged (no token, no URL) and fails closed: the status says
 * it could not be set up, not that it is on.
 */
export function startAccount({
  settings, safeStorage, userData, platform = process.platform, fetch = globalThis.fetch,
  openExternal, log = () => {}, onDirty = () => {}, now = Date.now,
} = {}) {
  let store = null
  let flow = null
  if (settings?.enabled === true && !settings.problem) {
    try {
      store = createTokenStore({ safeStorage, platform, userData })
      flow = createSignInFlow({ settings, fetch, openExternal, log })
    } catch (error) {
      log(`account: not started (${error?.message ?? error})`)
      store = null
      flow = null
    }
  }
  return { account: createAccount({ settings, flow, store, log, onDirty, now }), store, flow }
}
