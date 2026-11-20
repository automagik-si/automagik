import { chromium as playwright } from 'playwright-core'

export let observed

export const chromium = {
  async launchPersistentContext(profile, options) {
    const context = await playwright.launchPersistentContext(profile, {
      ...options,
      args: [...options.args, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    })
    const failed = []
    context.on('requestfailed', request => failed.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }))
    observed = { context, failed }
    return context
  },
}
