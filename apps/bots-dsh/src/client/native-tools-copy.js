// Details-only strings. Register them with the main client so the Code pane
// keeps the same dictionary and standalone bundle.
export const nativeToolsCopy = {
  label: 'Native tools',
  on: "In its own chat with you, Claude Code uses its own tools (Bash, Read, Edit…). They run outside Automagik's file sandbox. What asks you first depends on the permission level. Turning this off stops its running session at once.",
  off: "Claude Code uses Automagik's tools, approved in Automagik. Groups, tasks and scheduled runs always do. Applies from your next message in this Bot's direct chat. Turning it off ends the running session.",
}

export const nativeToolsZh = {
  [nativeToolsCopy.label]: '原生工具',
  [nativeToolsCopy.on]: '在它与你的单独对话中，Claude Code 使用它自己的工具（Bash、Read、Edit…）。这些工具在 Automagik 的文件沙盒之外运行；哪些操作会先询问你取决于权限级别。关闭后会立即停止它正在运行的会话。',
  [nativeToolsCopy.off]: 'Claude Code 使用 Automagik 的工具，并在 Automagik 中审批。群组、任务和定时运行始终如此。从你在此 Bot 的单独对话中发送的下一条消息起生效。关闭后会结束正在运行的会话。',
  'Not available at the Read only level.': '在“仅可查看”级别下不可用。',
  "Not available: the permission level of this Bot's chat could not be read.": '不可用：无法读取此 Bot 对话的权限级别。',
  'Not available while this Bot is shared with other people or a sharing plugin (LiveShare) is installed.': '此 Bot 已与他人共享，或已安装共享插件（LiveShare），因此不可用。',
  'Not available while this Bot has shell access off or denied tools.': '此 Bot 关闭了 Shell 访问或设置了禁止使用的工具，因此不可用。',
  'Not available for a Bot that operates Omni or that another plugin manages.': '对于操作 Omni 或由其他插件管理的 Bot 不可用。',
}
