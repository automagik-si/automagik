// The refusal of Bot work while multiuser mode has no Bot runner (RFC 0038 delivery 3). It imports nothing, so
// any host module (role-runtime.js among them) can name it without loading the runner gate.
export const NO_BOT_RUNNER = 'bot/no-runner'
export const NO_BOT_RUNNER_REASON = 'ds-bot: this workspace has no Bot runner yet, so a Bot runs no commands, terminals, coding CLIs, browsers or extensions in multiuser mode (RFC 0038)'
