import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_TIMEOUT_MS, run, workDirectory } from './runner-client.js'

export const BOT_SHELL = 'bot_shell'
const DEFAULT_TIMEOUT_MS = 120_000

export function shellRequest(config, botId, args, mode, refuse) {
  if (args !== null && typeof args === 'object' && Object.hasOwn(args, 'sandbox_permissions')) {
    throw refuse(' (Bot shell escalation is unavailable)')
  }
  if (mode === 'read-only') throw refuse(' (the runner does not enforce read-only yet)')
  if (mode !== 'workspace-write') throw refuse(' (Bot commands require workspace-write)')
  if (typeof args?.command !== 'string' || args.command.trim() === '' || args.command.includes('\0')
    || Object.keys(args).some(key => !['command', 'cwd', 'timeoutMs'].includes(key))) {
    throw refuse(' (expected a foreground command with optional cwd and timeoutMs)')
  }
  const cwd = workDirectory(config.workRoot, botId, args.cwd)
  if (cwd === undefined) throw refuse(' (cwd must stay inside the Bot command area)')
  const timeout = args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : args.timeoutMs
  if (!Number.isInteger(timeout) || timeout < 1) throw refuse(' (timeoutMs must be a positive integer)')
  return { botId, argv: ['/bin/sh', '-c', args.command], cwd, timeoutMs: Math.min(timeout, MAX_TIMEOUT_MS) }
}

export function createBotShell(dispatch) {
  return Object.freeze(defineTool({
    name: BOT_SHELL,
    description: 'Run one foreground shell command in the Bot’s command area. This area is separate from the file tools’ workspace.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run.' },
      cwd: { type: 'string', description: 'Path inside the Bot command area. Relative paths start at its root.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          refusal: {
            type: 'object',
            additionalProperties: false,
            properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
          },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: [
          `[exit code: ${result.code}]`,
          result.timedOut ? 'Command timed out.' : '',
          result.truncated ? 'Output truncated.' : '',
          result.refusal ? `${result.refusal.code}: ${result.refusal.message}` : '',
          result.stdout === '' ? '' : `stdout:\n${result.stdout}`,
          result.stderr === '' ? '' : `stderr:\n${result.stderr}`,
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(args, exec) {
      const request = dispatch(args, exec)
      return run({ ...request, signal: exec.signal })
    },
  }))
}
