import { carriesKnownState } from './cli-login-model.js'
import { t } from './i18n.js'

export const showSignInCodeNotice = actions => actions.showNotice(t('This message contains a sign-in code, so it was not sent. Paste the code only in the sign-in step.'))

export function refuseKnownState(text, actions) {
  if (!carriesKnownState(text)) return false
  showSignInCodeNotice(actions)
  return true
}

export function guardSignInCodeTransfer(event, actions) {
  const text = (event.clipboardData ?? event.dataTransfer)?.getData('text/plain')
  if (refuseKnownState(text, actions)) event.preventDefault()
}
