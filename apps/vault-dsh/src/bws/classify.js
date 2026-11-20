export function supportedVersion(result) {
  return result.code === 0 && result.stderr === ''
    ? /^bws (2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+[\w.-]+)?\r?\n?$/.exec(result.stdout)?.[1]
    : undefined
}

const responseCause = /^Received error message from server: \[(\d{3}) ([^\]]+)\](?:[ \t]+(.*))?$/

function causesOf(stderr) {
  const report = /^Error: *\n([^\n]+(?:\n[^\n]+)*)\n\nLocation:\n +crates[\\/]bws[\\/]src[\\/][\w\\/]+\.rs:\d+(?:\n|$)/
    .exec(stderr.replaceAll('\r\n', '\n').trimEnd())
  if (report === null) return undefined
  const [, chain] = report
  const causes = chain.split('\n').map((row, index) => {
    const cause = /^ +([0-9]+): (.+)$/.exec(row)
    return Number(cause?.[1]) === index ? cause[2] : undefined
  })
  if (causes.some(cause => cause === undefined)) return undefined
  return causes
}

export function classify(version, result) {
  if (result.failure === 'refused') return 'refused'
  if (version !== '2.1.0' || result.failure !== undefined || !Number.isInteger(result.code)
    || result.code === 0 || !result.stderr) return 'unavailable'
  const causes = causesOf(result.stderr)
  if (causes === undefined) return 'unavailable'
  const responses = causes.map(cause => responseCause.exec(cause)).filter(Boolean)
  if (responses.length !== 1) return 'unavailable'
  const [, status, reason, body] = responses[0]
  if (status === '401') return 'auth'
  // bws 2.1.0 reports identity and item API failures in the same format.
  if (status !== '400' || reason !== 'Bad Request') return 'unavailable'
  try {
    const error = JSON.parse(body)?.error
    if (error === 'invalid_client' || error === 'invalid_grant') return 'auth'
  } catch {}
  return 'unavailable'
}
