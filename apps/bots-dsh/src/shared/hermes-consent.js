// The answer sent back to Hermes stays canonical across desktop and Pocket.
export const SANDBOX_ALLOW = 'Allow until sandbox is off'
export const isSandboxGrant = question => question?.intent?.kind === 'approval' && question.intent.approve === SANDBOX_ALLOW
