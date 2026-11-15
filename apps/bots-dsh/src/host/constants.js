// Fixed values shared by the host modules: colors, OCR settings, the client route, and
// the limits on messages, group chats, and chat reads.

// Classic avatar inks, offered as Bot colors.
export const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
// Deeper inks, also offered as accent swatches; each is a valid Bot color too.
export const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
// Renamed color ids, so a Bot saved with an old one keeps its color (LEGACY: old id → new id).
export const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
// Renamed theme ids, so a saved choice keeps its look (LEGACY: old id → new id).
export const LEGACY_THEMES = { grok: 'mono' }

export const OCR_PROMPT = [
  'Transcribe all text in this image exactly, in its original language, keeping line breaks and reading order; use Markdown tables for tables.',
  'Then add a line starting with "Image:" that describes in one to three sentences what is not text (photo, chart, diagram, screen layout).',
  'Reply with only that. If there is no text, reply with only the "Image:" line.',
].join(' ')
export const OCR_TIMEOUT_MS = 120_000
export const OCR_RETRY_MS = 120_000
export const OCR_CACHE_MAX = 500
export const MAX_AVATAR_IMAGE = 160_000
export const ROUTE = '/api/omni-ui'
// Pet sheets (pets.js), as bytes beside the JSON endpoints.
export const PET_ROUTE = `${ROUTE}/pet`
export const PET_CODEX_ROUTE = `${ROUTE}/pet-codex`
// Generated images (imagegen.js), by id.
export const IMAGE_ROUTE = `${ROUTE}/image`
// The Automagik desktop app (OMNI_CLIENT_ID) updates as a whole and carries the Bot browser;
// upstream's own app says so with DS_BOT_APP.
export const inDesktopApp = () => process.env.OMNI_CLIENT_ID === 'omni-desktop' || process.env.DS_BOT_APP === '1'
// The Automagik desktop app keeps each Bot's browser in its window and answers the browser
// bridge (browser-plugins.js appBrowserEndpoint) over dsh's IPC channel. Unlike DS_BOT_APP, it
// turns on the Bot browser panel alone, not read_browser (browser.js).
export const appBrowserBridge = () => process.env.AUTOMAGIK_APP_BROWSER === '1' && typeof process.send === 'function'
// Unfold's own Automagik instance (AUTOMAGIK_HOST=unfold or AUTOMAGIK_PRELOAD=unfold, either one):
// Unfold ships the instance whole and keeps its privacy, so the team there checks for no update,
// drives no browser, leaves the Privacy page to Unfold and waits for Unfold to lead. The same
// rule is unfold-bot-dsh's unfoldLeads and welcome-dsh's hostOf.
export const inUnfoldInstance = (env = process.env) => [env.AUTOMAGIK_HOST, env.AUTOMAGIK_PRELOAD].some(value => String(value ?? '').trim().toLowerCase() === 'unfold')
export const MAX_EXCHANGES = 600
// state.json is written whole on every save, so a long message between Bots or a long
// group line keeps only its start there. The rest stays where it already is (a message
// in the Session it was delivered to) or in a file of its own (a group line).
export const TEXT_KEPT = 2000
// Of one group line, a member reads this much: in its prompt, and with read_group_chat.
export const GROUP_LINE_READ = 20_000
// The Bot exchange dialog shows at most this much of one message.
export const TEXT_SHOW_MAX = 200_000
// A message a Bot sends past this goes as a DSH file, which the recipient reads with its
// file tools; the message keeps its first LONG_HEAD characters.
export const MESSAGE_INLINE_MAX = GROUP_LINE_READ
export const LONG_HEAD = 1000
// DSH's read tool shows this much of one line (dsh-tool-fs `readMaxLineLength`, default).
export const READ_LINE_MAX = 2000
export const ROOM_REPLY_TIMEOUT_MS = 240_000
// Lines a member writes less than this apart while it works reach its group together.
export const ROOM_STEP_GAP_MS = 30_000
export const SOURCE_KIND = 'bot'
// The fixed reply that opens a fresh conversation part; it is never shown or sent on.
export const HANDOFF_ACK = 'Noted. I have my handoff note and carry on from here.'
// A result that arrives after the user gave up waiting for it: it settled once
// already, so it closes nothing and opens nothing, and its text says why it is late.
export const LATE_ANSWER = '[Late answer: the user had already given up waiting for this work; its result was settled then.]\n\n'
// An answer from a question card, in the shape DSH's own late question replies use.
export const REPLY_KIND = 'user-question-reply'
// DSH's snapshot of a referenced conversation, logged right after the user's message
// that cites it.
export const REFERENCE_KIND = 'session-reference'
// `everyone`: every member answers a plain message in turn, admin first. `admin`: a
// plain message goes to the admin, who calls others with @mentions. New groups start
// in `admin` mode, because every extra speaker re-reads its whole context; a group
// without an admin still answers as `everyone`.
export const ROOM_MODES = ['everyone', 'admin']
export const ROOM_NAME_MAX = 60
export const ROOM_NOTICE_MAX = 2000
export const ROOM_MAX_MEMBERS = 12
export const SECTION_NAME_MAX = 32
export const SECTION_COLORS = ['blue', 'orange', 'green', 'violet', 'rose']

// DSH bots: plain dsh entries in the sidebar, not Bots, and the one record that keeps the
// Sessions of the tasks Bots start (agents.js). Their Sessions are ordinary root Sessions,
// so the team tools must not be offered to them.
export const AGENT_NAME = 'Tasks'
export const AGENT_SESSION_TITLE_MAX = 80
export const DSH_BOT_NAME_MAX = 40
// Every tool this plugin defines for Bot Sessions; tools.js registers them in
// each Bot session's own scope. `read_browser` only exists in the Desktop
// profile, so the list served to one session can be shorter.
export const TEAM_TOOLS = [
  'list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'delete_bot', 'list_bot_models',
  'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'show_view',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
  'list_capabilities', 'save_capability', 'delete_capability',
  'attach_capability', 'detach_capability', 'group_goal', 'list_connectors', 'request_connector',
  'find_chats', 'list_automations', 'save_automation', 'pause_automation', 'delete_automation',
  'generate_image',
  'omni_endpoints', 'omni_call', 'omni_channels', 'omni_chats', 'omni_messages', 'omni_send', 'omni_react', 'omni_media', 'omni_delete', 'omni_connect', 'show_canvas', 'start_task',
]
// Team tools that take a while (an image takes up to two minutes): in a group they are work,
// not a quick call.
export const SLOW_TEAM_TOOLS = Object.freeze(['generate_image'])
// Consecutive automatic admin wakes with no goal progress before the goal waits
// for the user instead of waking the admin again.
export const GOAL_IDLE_NUDGES = 2
// A member still at work this long after its first tool call lets the round go on; it
// posts its reply when the work is done.
export const ROOM_WORK_GRACE_MS = 15_000
// Consecutive Bot-to-Bot relays with no tool call and only repetitive or ack text
// before the round parks the remaining calls and asks the user before continuing.
export const ROOM_IDLE_RELAY_LIMIT = 6

export const OWN_CHAT_LINE_MAX = 400
// The message an anchor points at is shown whole (up to this), so a long draft takes
// one read instead of many searches for its pieces.
export const ANCHOR_LINE_MAX = 8000
export const OWN_CHAT_BRIEF = 10
export const OWN_CHAT_READ = 12
export const OWN_CHAT_SEARCH = 20
export const HISTORY_PAGE = 200
export const HISTORY_PAGES_MAX = 50
export const HISTORY_TIMEOUT_MS = 20_000
// Shown when an aside stops at the route's own output limit. The partial answer stays.
export const ASIDE_LIMIT = 'Answer cut off at the output limit.'

export const STEER_CUT = 'ds-bot/steer'
