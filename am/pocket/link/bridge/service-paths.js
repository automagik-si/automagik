const entities = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }
export const xml = value => value.replace(/[&<>"']/g, c => `&${entities[c]};`)
const unxml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) =>
  Object.keys(entities).find(c => entities[c] === entity))
// systemd reports the configured argv before it expands environment variables at execution.
export const configuredArg = value => value.replaceAll('$', () => '$$')
export const unitArg = (value, exec = false) => '"' + (exec ? configuredArg(value) : value).replace(/[\\\n\r\t"%]/g, c =>
  ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '"': '\\"', '%': '%%' })[c]) + '"'

function unitWords(line, exec = false) {
  return [...(line ?? '').matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map(([, quoted, plain]) => {
    const value = quoted === undefined ? plain : quoted.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c)
    return exec ? value.replace(/%%/g, '%').replace(/\$\$/g, '$') : value.replace(/%%/g, '%')
  })
}

/** Paths from both the old service body and the quoted body Pocket Link writes today. */
export function servicePaths(text = '') {
  if (/<plist\b|<key>ProgramArguments<\/key>/.test(text)) {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
    const [node, entry] = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(([, value]) => unxml(value))
    const state = /<key>POCKET_LINK_STATE_DIR<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
    return { node, entry, state: state === undefined ? undefined : unxml(state) }
  }
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1]
  const [node, entry] = unitWords(exec, true)
  const state = [...text.matchAll(/^Environment=(.*)$/gm)].flatMap(([, line]) => unitWords(line))
    .find(value => value.startsWith('POCKET_LINK_STATE_DIR='))?.slice('POCKET_LINK_STATE_DIR='.length)
  return { node, entry, state }
}

