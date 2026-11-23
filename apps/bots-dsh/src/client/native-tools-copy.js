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

export const nativeToolsZh = {
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
