// The pages of the team's Settings dialog, by id and English label (the client translates the
// label). settings.js draws them, and show_settings (host/tools.js) opens one of them inside
// the chat: both read this list, so a page the dialog has is a page a Bot can show.
// `models` is there only in a window without DSH's own settings; `hermes-remote` and the
// pages other plugins add (`plugin:<id>`) are added by the dialog itself.
export const SETTINGS_PAGES = [
  ['general', 'General'], ['models', 'Models'], ['bots', 'Bots'], ['groups', 'Group chats'],
  ['connectors', 'Connectors'], ['capabilities', 'Capabilities'], ['browser', 'Browser'],
  ['computer', 'Computer use'], ['schedules', 'Scheduled tasks'], ['usage', 'Usage'], ['secrets', 'Secrets'],
  ['agent-access', 'Agent access'], ['privacy', 'Privacy'], ['feedback', 'Feedback'],
  ['about', 'About Automagik'],
]

// What a Bot may name with show_settings: the pages above, Remote Hermes, and any
// plugin's page as `plugin:<id>`. Whether a plugin page exists is only known in the
// window, so the card says so when it does not.
export const SHOWABLE_PAGES = [...SETTINGS_PAGES.map(([id]) => id), 'hermes-remote']
const PLUGIN_PAGE = /^plugin:[a-z0-9][a-z0-9._-]{0,63}$/

export const isShowablePage = page => typeof page === 'string' && (SHOWABLE_PAGES.includes(page) || PLUGIN_PAGE.test(page))
