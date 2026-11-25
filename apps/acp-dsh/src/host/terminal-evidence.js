// Evidence from session/update on the live ACP connection. Permission payloads, card
// titles, status alone and terminal output text cannot supply a command outcome.
const present = value => typeof value === 'string' && value !== ''
const commandOf = input => input?.command ?? input?.cmd
const interrupted = exit => exit.signal != null || [
  'aborted', 'cancelled', 'canceled', 'interrupted', 'stopped', 'timed_out', 'timedOut',
].some(key => exit[key] != null && exit[key] !== false)

export function observeTerminal(tool, update, sessionId) {
  if (!tool.terminalEvidence && update.kind !== 'execute') return
  const evidence = tool.terminalEvidence ??= { sessionId }
  const conflict = reason => { evidence.reason ??= reason }
  const bind = (key, value, reason) => {
    if (value === undefined) return
    if (!present(value) || (evidence[key] !== undefined && evidence[key] !== value)) conflict(reason)
    else evidence[key] = value
  }
  if (evidence.sessionId !== sessionId || (update.kind != null && update.kind !== 'execute')) {
    conflict('The ACP execute call identity changed.')
  }
  const { rawInput, status, _meta: meta } = update
  bind('command', commandOf(rawInput), 'The ACP command input is ambiguous.')
  bind('cwd', rawInput?.cwd, 'The ACP working directory is ambiguous.')
  bind('cwd', meta?.terminal_info?.cwd, 'The ACP working directory is ambiguous.')
  const bindTerminal = value => bind('terminalId', value, 'The ACP terminal identity is ambiguous.')
  bindTerminal(meta?.terminal_info?.terminal_id)
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item?.type === 'terminal') bindTerminal(item.terminalId ?? null)
    }
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

export function terminalOutcome(live, tool, args, exec) {
  const missing = reason => ({ reason })
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
  if (!evidence?.exit) return missing('Trusted ACP terminal exit data is missing.')
  const { cwd, command, terminalId, exit, status } = evidence
  if (evidence.sessionId !== run.sessionId || !terminalId || terminalId !== exit.terminalId) {
    return missing('The ACP terminal exit does not match the execute call.')
  }
  if (!command || command !== commandOf(args.input)) return missing('The ACP mirror command differs from the observed input.')
  if (!cwd) return missing('The ACP working directory is missing.')
  if (args.input?.cwd !== undefined && args.input.cwd !== cwd) return missing('The ACP mirror working directory differs from the observed input.')
  if (status !== 'completed' && !(status === 'failed' && exit.exitCode !== 0)) {
    return missing('The ACP execute call did not reach a matching completion.')
  }
  return { sessionId, callId, toolCallId: tool.id, terminalId, cwd, exitCode: exit.exitCode }
}
