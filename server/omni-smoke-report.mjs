import { SECRET_NAME, safeDshLine } from './lib.mjs'

// This function is serialized into the container probe and must be self-contained.
export function omniJobFailure({ phase, step, error, next, mismatch, log }) {
  const lines = []
  if (mismatch?.length) lines.push('mismatch: ' + mismatch.join(', '))
  log ??= ''
  const logLines = log.split(/\r?\n/)
  // Older installers could start a near-full log in the middle of a line.
  if (new TextEncoder().encode(log).length >= 40 * 1024) logLines.shift()
  const tail = logLines.filter(line => line.trim()).slice(-20)
  if (tail.length) lines.push('job log:', ...tail)
  return {
    headline: `Omni job ${phase} at ${step ?? 'no step'} (next: ${next ?? 'none'})`,
    error: error ?? 'no error',
    lines,
  }
}

const UNTERMINATED_SECRET = new RegExp(
  String.raw`((?<![\w.\-])["']?${SECRET_NAME}["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*\\?|'(?:\\.|[^'\\])*\\?)$`, 'i',
)
const JOB_LOG_LINE_MAX = 300
const safeLine = line => safeDshLine(line).replace(UNTERMINATED_SECRET, '$1<redacted>')

export function omniSmokeErrorLines(failure) {
  const [headline, ...lines] = typeof failure === 'string'
    ? failure.split('\n').map(safeLine)
    : [safeLine(failure.headline) + ': ' + safeLine(failure.error), ...failure.lines.map(safeLine)]
  const logStart = lines.indexOf('job log:')
  const details = lines.map((safe, index) => {
    if (logStart !== -1 && index > logStart && safe.length > JOB_LOG_LINE_MAX) {
      return safe.slice(0, JOB_LOG_LINE_MAX - 1) + '…'
    }
    return safe
  })
  return ['OMNI SMOKE FAILED: ' + headline, ...details]
}

export function untrustedOutput(lines, token) {
  return [`::stop-commands::${token}`, ...lines, `::${token}::`]
}
