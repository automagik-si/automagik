import { effectiveMarkOf, NATIVE_AGENTS, nativeToolsOn } from '../shared/native-tools.js'

// Details-only strings. Register them with the main client so the Code pane
// keeps the same dictionary and standalone bundle.
export const nativeToolsCopy = {
  label: 'Native tools',
  on: "Claude Code uses its own tools (Bash, Read, Edit…) in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run outside Automagik's file sandbox. What asks you first depends on the permission level. Turning this off stops its running sessions at once.",
  off: "Claude Code uses Automagik's tools, approved in Automagik, in all of this Bot's chats. Turning this on applies from the next message in each chat.",
  codexOn: "Codex uses its own tools (commands, file edits…) in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run in Codex's own sandbox, outside Automagik's. What asks you first depends on the permission level. Turning this off stops its running sessions at once.",
  codexOff: "Codex uses Automagik's tools, approved in Automagik, in all of this Bot's chats. Turning this on applies from the next message in each chat.",
  modelKept: "This model can't turn its native tools off.",
}

export const ompNativeToolsCopy = {
  on: "omp uses its own tools in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run outside Automagik's file sandbox. Turning this off stops its running sessions at once.",
  off: "With this off, omp has no tools at all in any of this Bot's chats, so this Bot can only chat. Turning this on applies from the next message in each chat.",
  blocked: 'Here omp has no tools, so this Bot can only chat.',
}

// Antigravity (#1564): like omp, OFF leaves it with no tools at all (it has no DSH bridge); its asks
// go through DSH's approval, as Claude Code's and Codex's do.
export const antigravityNativeToolsCopy = {
  on: "Antigravity uses its own tools in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run outside Automagik's file sandbox. What asks you first depends on the permission level. Turning this off stops its running sessions at once.",
  off: "With this off, Antigravity has no tools at all in any of this Bot's chats, so this Bot can only chat. Turning this on applies from the next message in each chat.",
  blocked: 'Here Antigravity has no tools, so this Bot can only chat.',
  unchecked: 'Native tools off is checked on agy {version}; this version was not checked.',
  hooks: "Antigravity can't start with native tools off while its settings hold a hooks.json file. Remove hooks.json to use it with native tools off.",
  plugins: "Antigravity can't start with native tools off while its settings hold plugins.",
  fresh: 'Switch account on Antigravity in Settings starts it with empty settings; it also signs it out.',
}

// The text a lock shows, by the host's `nativeToolsBlock` code.
export const NATIVE_TOOLS_HINTS = {
  'model-kept': nativeToolsCopy.modelKept,
  managed: 'Not available for a Bot that operates Omni or that another plugin manages.',
  shared: 'Not available while this Bot is shared with other people or a sharing plugin (LiveShare) is installed.',
  restricted: 'Not available while this Bot has shell access off or denied tools.',
  'read-only': 'Not available at the Read only level.',
  'level-unknown': "Not available: the permission level of this Bot's chat could not be read.",
}

/**
 * The native-tools switch as one Bot shows it: null when it has no switch (an agent without
 * one, or a multi-user workspace), else whether it reads ON, whether it is locked, the lock's
 * code and the hint as untranslated keys (joined with a space once translated). The Details
 * switch and the New Solver dialog's tick both read this one function, so they always show
 * the same thing for the same Bot.
 */
export function nativeSwitchView(bot, roster) {
  const mark = effectiveMarkOf(bot)
  // `unoffered`: an acp-dsh without Antigravity's switch, which runs agy with its own tools as before.
  if (!NATIVE_AGENTS.includes(mark) || bot.nativeToolsBlock === 'multiuser' || bot.nativeToolsBlock === 'unoffered') return null
  const copy = mark === 'acp-omp' ? ompNativeToolsCopy : mark === 'acp-antigravity' ? antigravityNativeToolsCopy
    : mark === 'acp-codex' ? { on: nativeToolsCopy.codexOn, off: nativeToolsCopy.codexOff } : nativeToolsCopy
  const blocked = NATIVE_TOOLS_HINTS[bot.nativeToolsBlock]
  // A Codex model the switch never applies to (`model-kept`) shows OFF and locked: no OFF promise.
  const on = blocked === undefined && nativeToolsOn(bot)
  // omp and Antigravity have no bridge: locked means no tools at all.
  const hint = blocked === undefined ? [on ? copy.on : copy.off]
    : copy.blocked !== undefined ? [blocked, copy.blocked] : [blocked]
  return { mark, on, disabled: blocked !== undefined || Boolean(roster?.readOnly), blocked, hint }
}

export const nativeToolsZh = {
  [antigravityNativeToolsCopy.on]: 'Antigravity 在此 Bot 的所有对话中使用它自己的工具：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Automagik 的文件沙盒之外运行；哪些操作会先询问你取决于权限级别。关闭后会立即停止它正在运行的会话。',
  [antigravityNativeToolsCopy.off]: '关闭后，Antigravity 在此 Bot 的所有对话中都没有任何工具，此 Bot 只能聊天。开启后，从每个对话的下一条消息起生效。',
  [antigravityNativeToolsCopy.blocked]: '在这里 Antigravity 没有任何工具，此 Bot 只能聊天。',
  [antigravityNativeToolsCopy.unchecked]: '关闭原生工具已在 agy {version} 上验证；此版本尚未验证。',
  [antigravityNativeToolsCopy.hooks]: 'Antigravity 的设置中有 hooks.json 文件时，无法在关闭原生工具的情况下启动。删除 hooks.json 后即可在关闭原生工具时使用。',
  [antigravityNativeToolsCopy.plugins]: 'Antigravity 的设置中有插件时，无法在关闭原生工具的情况下启动。',
  [antigravityNativeToolsCopy.fresh]: '在设置中对 Antigravity 使用“切换账号”，会以空白设置重新开始，同时也会退出它的登录。',
  [ompNativeToolsCopy.on]: 'omp 在此 Bot 的所有对话中使用它自己的工具：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Automagik 的文件沙盒之外运行。关闭后会立即停止它正在运行的会话。',
  [ompNativeToolsCopy.off]: '关闭后，omp 在此 Bot 的所有对话中都没有任何工具，此 Bot 只能聊天。开启后，从每个对话的下一条消息起生效。',
  [ompNativeToolsCopy.blocked]: '在这里 omp 没有任何工具，此 Bot 只能聊天。',
  [nativeToolsCopy.label]: '原生工具',
  [nativeToolsCopy.on]: 'Claude Code 在此 Bot 的所有对话中使用它自己的工具（Bash、Read、Edit…）：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Automagik 的文件沙盒之外运行；哪些操作会先询问你取决于权限级别。关闭后会立即停止它正在运行的会话。',
  [nativeToolsCopy.off]: 'Claude Code 在此 Bot 的所有对话中使用 Automagik 的工具，并在 Automagik 中审批。开启后，从每个对话的下一条消息起生效。',
  [nativeToolsCopy.codexOn]: 'Codex 在此 Bot 的所有对话中使用它自己的工具（命令、文件编辑…）：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Codex 自己的沙盒中运行，不在 Automagik 的沙盒内；哪些操作会先询问你取决于权限级别。关闭后会立即停止它正在运行的会话。',
  [nativeToolsCopy.codexOff]: 'Codex 在此 Bot 的所有对话中使用 Automagik 的工具，并在 Automagik 中审批。开启后，从每个对话的下一条消息起生效。',
  [nativeToolsCopy.modelKept]: '此模型无法关闭其原生工具。',
  'Not available at the Read only level.': '在“仅可查看”级别下不可用。',
  "Not available: the permission level of this Bot's chat could not be read.": '不可用：无法读取此 Bot 对话的权限级别。',
  'Not available while this Bot is shared with other people or a sharing plugin (LiveShare) is installed.': '此 Bot 已与他人共享，或已安装共享插件（LiveShare），因此不可用。',
  'Not available while this Bot has shell access off or denied tools.': '此 Bot 关闭了 Shell 访问或设置了禁止使用的工具，因此不可用。',
  'Not available for a Bot that operates Omni or that another plugin manages.': '对于操作 Omni 或由其他插件管理的 Bot 不可用。',
}
