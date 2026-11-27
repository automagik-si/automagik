// Evidence from session/update on the live ACP connection. Permission payloads, card
// titles, status alone and terminal output text cannot supply a command outcome.
import { claudeNativeBash, isWorkspacePath, stripsWorkspaceCd } from './workspace-cd.js'

const present = value => typeof value === 'string' && value !== ''
const commandOf = input => input?.command ?? input?.cmd
const commandConflict = 'The ACP command input is ambiguous.'
const cwdConflict = 'The ACP working directory is ambiguous.'
const cwdMissing = 'The ACP working directory is missing.'
const identityConflict = 'The ACP execute call identity changed.'
const terminalConflict = 'The ACP terminal identity is ambiguous.'
const interrupted = exit => exit.signal != null || [
  'aborted', 'cancelled', 'canceled', 'interrupted', 'stopped', 'timed_out', 'timedOut',
].some(key => exit[key] != null && exit[key] !== false)

const namesOf = update => [update.name, update._meta?.claudeCode?.toolName].filter(present)
const claimsMcp = (update, names) => update._meta?.is_mcp_tool_call === true
  || typeof update.rawInput?.server === 'string' || names.some(name => name.startsWith('mcp__'))

function bindClaudeIdentity(tool, update) {
  // This binding outlives sparse notifications and does not follow the card's mutable name.
  const identity = tool.claudeTerminalIdentity ??= {}
  const names = namesOf(update)
  identity.name ??= names[0]
  identity.bash ||= names.includes('Bash')
  identity.conflict ||= names.some(name => name !== identity.name) || claimsMcp(update, names)
    || tool.mcp === true || tool.mcpServer !== undefined
  return identity
}

export function vetoClaudeTerminalIdentity(tool, update, permission) {
  const identity = tool.claudeTerminalIdentity
  if (identity?.name === undefined) return
  const names = namesOf(update)
  if (names.some(name => name !== identity.name) || claimsMcp(update, names)
    || permission._meta?.is_mcp_tool_approval === true) {
    identity.conflict = true
    // Keep the veto on the identity even if the first execute notification is still pending.
    identity.bash ||= names.includes('Bash')
    const evidence = tool.terminalEvidence
    if (identity.bash && evidence !== undefined) evidence.reason ??= identityConflict
  }
}

export function observeTerminal(tool, update, sessionId, observedAt, { claude = false, firstSight = false } = {}) {
  const identity = claude ? bindClaudeIdentity(tool, update) : undefined
  if (!tool.terminalEvidence && update.kind !== 'execute') return
  const fresh = tool.terminalEvidence === undefined
  const evidence = tool.terminalEvidence ??= { sessionId }
  const conflict = reason => { evidence.reason ??= reason }
  const bind = (key, value, reason) => {
    if (value === undefined) return
    if (!present(value) || (evidence[key] !== undefined && evidence[key] !== value)) conflict(reason)
    else evidence[key] = value
  }
  if (evidence.sessionId !== sessionId || (update.kind != null && update.kind !== 'execute')) {
    conflict(identityConflict)
  }
  if (identity?.bash && identity.conflict) conflict(identityConflict)
  const { rawInput, status, _meta: meta } = update
  const command = commandOf(rawInput)
  if (claude && present(command) && evidence.command !== undefined && command !== evidence.command
    && evidence.refinedCommand === undefined) {
    evidence.refinedCommand = command
    evidence.refinedInput = rawInput
  } else if (evidence.refinedCommand !== undefined && command !== undefined) {
    if (command !== evidence.refinedCommand) conflict(commandConflict)
  } else {
    bind('command', command, commandConflict)
    if (claude && evidence.command !== undefined) evidence.firstInput ??= rawInput
  }
  bind('cwd', rawInput?.cwd, cwdConflict)
  bind('cwd', meta?.terminal_info?.cwd, cwdConflict)
  bind('workdir', rawInput?.workdir, cwdConflict)
  const terminal = meta?.terminal_info?.terminal_id
  const bindTerminal = value => bind('terminalId', value, terminalConflict)
  bindTerminal(terminal)
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item?.type === 'terminal') bindTerminal(item.terminalId ?? null)
    }
  }
  if (claude && firstSight && fresh && update.kind === 'execute' && status === 'pending'
    && identity.name === 'Bash' && !identity.conflict && present(terminal)) {
    if (terminal !== update.toolCallId || terminal !== tool.id) conflict(terminalConflict)
    else if (!evidence.reason && terminal === evidence.terminalId && meta?.terminal_exit === undefined) {
      evidence.pendingStart = { terminalId: terminal, sessionId, name: identity.name, at: observedAt }
    }
  }
  // Output may contradict an already observed terminal, but cannot establish its identity.
  const outputTerminal = meta?.terminal_output?.terminal_id
  if (evidence.pendingStart && outputTerminal !== undefined && outputTerminal !== evidence.pendingStart.terminalId) {
    conflict(terminalConflict)
  }
  // Capture the first live terminal start on notification intake, before the mirror can drain.
  if (status === 'in_progress' && evidence.start === undefined && evidence.exit === undefined
    && meta?.terminal_exit === undefined && !['completed', 'failed'].includes(evidence.status)) {
    evidence.start = { terminalId: evidence.terminalId, at: observedAt }
  }
  if (status != null) {
    if (['completed', 'failed'].includes(evidence.status) && status !== evidence.status) {
      conflict('The ACP execute call reported conflicting completion states.')
    }
    evidence.status = status
  }

  if (meta?.terminal_exit === undefined) return
  const exit = meta.terminal_exit
  if (exit && interrupted(exit)) {
    conflict('The ACP terminal execution was interrupted.')
  } else if (!present(exit?.terminal_id) || !Number.isInteger(exit?.exit_code)) {
    conflict('The ACP terminal exit data is incomplete.')
  } else if (evidence.exit && (evidence.exit.terminalId !== exit.terminal_id || evidence.exit.exitCode !== exit.exit_code)) {
    conflict('The ACP call reported conflicting terminal exits.')
  } else {
    evidence.exit = { terminalId: exit.terminal_id, exitCode: exit.exit_code }
  }
}

export function terminalResult(live, tool, args, exec, launch) {
  const missing = reason => ({ terminalOutcome: { reason } })
  const { run } = live
  const sessionId = exec.agent?.session?.id
  const callId = exec.callId
  if (!present(sessionId) || live.calls?.has(callId) !== true || live.toolIds?.get(callId) !== tool.id) {
    return missing('The ACP mirror does not match the execute call.')
  }
  if (exec.signal?.aborted || run.cancelled || run.disposed || tool.ended || tool.unanswerable
    || tool.refused || tool.refusedReason || tool.confinedReason || tool.lastingReason || tool.judgeReason) {
    return missing('The ACP execute call was interrupted or refused.')
  }
  const evidence = tool.terminalEvidence
  if (evidence?.reason) return missing(evidence.reason)
  const identity = tool.claudeTerminalIdentity
  // The permission card can change the displayed name. Launch evidence needs the wire binding.
  const bashLaunch = identity?.name === 'Bash' && !identity.conflict ? launch : undefined
  if (!bashLaunch && evidence?.refinedCommand !== undefined) return missing(commandConflict)
  if (!evidence?.exit) return missing('Trusted ACP terminal exit data is missing.')
  const { command, terminalId, exit, status, pendingStart } = evidence
  let { cwd, start } = evidence
  if (evidence.sessionId !== run.sessionId || !terminalId || terminalId !== exit.terminalId) {
    return missing('The ACP terminal exit does not match the execute call.')
  }
  if (!command || command !== commandOf(args.input)) return missing('The ACP mirror command differs from the observed input.')
  if (bashLaunch) {
    const { workspace } = bashLaunch
    try {
      const directories = [evidence.workdir, cwd, args.input?.workdir, args.input?.cwd]
      if (directories.some(path => path !== undefined && !isWorkspacePath(path, workspace))) return missing(cwdConflict)
      if (evidence.refinedCommand !== undefined && !stripsWorkspaceCd(evidence.firstInput, evidence.refinedInput, bashLaunch)) {
        return missing(commandConflict)
      }
      if (!cwd && bashLaunch.solverCwdReset === true && run.spec.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR === '1'
        && isWorkspacePath(bashLaunch.workspaceArgument, workspace)) cwd = workspace
    } catch { return missing(cwdMissing) }
  }
  if (!cwd) return missing(cwdMissing)
  if (args.input?.cwd !== undefined && args.input.cwd !== cwd) return missing('The ACP mirror working directory differs from the observed input.')
  if (status !== 'completed' && !(status === 'failed' && exit.exitCode !== 0)) {
    return missing('The ACP execute call did not reach a matching completion.')
  }
  if (bashLaunch && pendingStart && claudeNativeBash(live, tool)
    && pendingStart.name === identity.name && pendingStart.sessionId === evidence.sessionId
    && pendingStart.terminalId === tool.id && tool.id === terminalId) start = pendingStart
  return {
    terminalOutcome: { sessionId, callId, toolCallId: tool.id, terminalId, cwd, exitCode: exit.exitCode },
    ...(start?.terminalId === terminalId ? { terminalStart: { observedAt: tool.observedAt, startedAt: start.at } } : {}),
  }
}
