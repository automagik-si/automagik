export const HELD_NOT_SET = 'The permission level of this conversation could not be set, so the agent is not running here. Restarting DeepSeek Harness, or changing the permission level, tries again.'
export const HELD_UNREAD = 'DeepSeek Harness could not check where this conversation comes from, so the agent is not running here. Send the message again; if this goes on, restart DeepSeek Harness.'
export const ACP_HELD_TEXT = 'This conversation is on hold while its permission level is checked, so the agent is not running here. Send the message again in a moment.'
export const NATIVE_TOOLS_CHANGED_TEXT = 'The tools setting changed; send again.'
export const HELD_LINES = new Set([HELD_NOT_SET, HELD_UNREAD, ACP_HELD_TEXT, NATIVE_TOOLS_CHANGED_TEXT])
