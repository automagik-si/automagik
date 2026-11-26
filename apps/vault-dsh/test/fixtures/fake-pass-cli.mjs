import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const fixtureValue = (key, field = 'password') => '  ' + digest(key + field) + '\n' + digest(field + key) + '\n\n'

if (basename(fileURLToPath(import.meta.url)) === 'pass-cli') {
  const root = dirname(fileURLToPath(import.meta.url))
  const { version, mode, tokenHash, share, id, items } = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'))
  const args = process.argv.slice(2)
  const operation = args[0] === '--version' ? 'version' : args.slice(0, 2).join(' ')
  const env = process.env
  const key = env.PROTON_PASS_ENCRYPTION_KEY
  const token = env.PROTON_PASS_PERSONAL_ACCESS_TOKEN
  const dir = env.PROTON_PASS_SESSION_DIR
  const allowed = new Set(['PATH', 'LANG', 'NO_COLOR', 'PROTON_PASS_NO_UPDATE_CHECK', 'PROTON_PASS_DISABLE_TELEMETRY',
    'PROTON_PASS_KEY_PROVIDER'])
  if (dir !== undefined) for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'PROTON_PASS_SESSION_DIR']) allowed.add(name)
  if (operation !== 'version') allowed.add('PROTON_PASS_ENCRYPTION_KEY')
  if (operation === 'login') allowed.add('PROTON_PASS_PERSONAL_ACCESS_TOKEN')
  const validEnv = Object.keys(env).every(name => allowed.has(name))
    && env.LANG === 'C' && env.NO_COLOR === '1' && env.PROTON_PASS_NO_UPDATE_CHECK === '1'
    && env.PROTON_PASS_DISABLE_TELEMETRY === '1' && env.PROTON_PASS_KEY_PROVIDER === 'env'
    && (operation === 'version' ? key === undefined : typeof key === 'string' && Buffer.from(key, 'base64url').length === 32)
    && (operation === 'login' ? typeof token === 'string' && digest(token) === tokenHash : token === undefined)
    && (dir === undefined ? operation === 'version' : dirname(dir) === root && (statSync(dir).mode & 0o777) === 0o700
      && ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'].every(name => env[name] === join(dir, 'home')))
  const expectedArgs = {
    version: ['--version'], login: ['login'], logout: ['logout'], 'vault list': ['vault', 'list', '--output', 'json'],
    'item list': ['item', 'list', '--share-id=' + share, '--filter-state', 'active', '--output', 'json'],
    'item view': ['item', 'view', '--share-id=' + share, '--item-id=' + id, '--output', 'json'],
  }
  const validArgs = JSON.stringify(args) === JSON.stringify(expectedArgs[operation])
  appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ operation, validEnv, validArgs, dir, keyHash: key && digest(key) }) + '\n')
  const stdout = text => writeSync(1, text + '\n')
  const stderr = text => writeSync(2, text + '\n')
  const error = message => { stderr(message); process.exitCode = 1 }
  if (!validEnv || !validArgs) error('fixture invocation refused')
  else if (operation === 'version') stdout(version)
  else if (operation === 'login') {
    writeFileSync(join(dir, 'session.digest'), digest(key), { mode: 0o600 })
    if (mode === 'login-hang') setInterval(() => {}, 1000)
    else if (mode === 'invalid-token') error('Error: Error in personal access token login flow\n\nCaused by:\n    This personal access token is invalid, expired or has been deleted.')
    else stdout('Personal access token session created successfully\nSuccessfully logged in as personal access token: Fixture')
  } else if (operation === 'logout') {
    if (mode === 'logout-hang') setInterval(() => {}, 1000)
    else if (mode === 'logout-fail') error('Error: Error sending request')
  } else if (operation === 'vault list') {
    stdout(JSON.stringify({ vaults: [{ share_id: share, vault_id: id, name: 'Fixture vault' }] }))
  } else if (operation === 'item list') {
    if (mode === 'list-hang') setInterval(() => {}, 1000)
    else stdout(JSON.stringify({ items, folders: [] }))
  } else if (operation === 'item view') {
    const diagnostics = {
      'share-missing': 'Error: Error retrieving share\n\nCaused by:\n    Share with id ' + share + ' not found',
      unknown: 'Error: Error retrieving item\n\nCaused by:\n    Invalid status code: 404',
      offline: 'Error: Error retrieving item\n\nCaused by:\n    Error sending request',
      policy: 'Error: Viewing the contents of this item is not allowed by policy',
      auth: 'Error: This operation requires an authenticated client',
      'invalidated-cause': 'Error: Error fetching shares: session has been invalidated',
      invalidated: 'Your session has been invalidated and you have been logged out automatically.\nPlease log in again with: pass login',
    }
    if (Object.hasOwn(diagnostics, mode)) {
      if (mode === 'unknown') stdout(fixtureValue(key))
      error(diagnostics[mode])
    } else if (mode === 'read-hang') setInterval(() => {}, 1000)
    else if (mode === 'oversize') {
      const block = Buffer.alloc(16384, 120)
      for (let bytes = 0; bytes <= 4 * 1024 * 1024;) bytes += writeSync(1, block)
    }
    else {
      if (mode === 'warn') stderr('unexpected warning')
      const note = fixtureValue(key, 'note')
      const password = mode === 'empty' ? '' : mode === 'wrong-value' ? 1 : fixtureValue(key)
      const login = { username: '', email: '', password, urls: [], totp_uri: '', passkeys: [], autofill_urls: [] }
      const variants = {
        login: { Login: login }, 'note-kind': { Note: null }, alias: { Alias: null },
        'bad-unit': { Alias: {} }, 'bad-object': { Login: null }, 'bad-array': { Login: [] },
        'multi-kind': { Login: login, Note: null }, 'unknown-kind': { Other: {} },
        card: { CreditCard: { verification_number: fixtureValue(key, 'card') } },
        wifi: { Wifi: { ssid: fixtureValue(key, 'wifi') } }, ssh: { SshKey: { private_key: fixtureValue(key, 'ssh') } },
      }
      stdout(JSON.stringify({ item: {
        id: mode === 'wrong-id' ? share : id, share_id: mode === 'wrong-share' ? id : share, vault_id: id,
        content: { title: 'Fixture item', note, item_uuid: 'fixture-uuid', content: variants[mode] ?? variants.login,
          extra_fields: [{ name: 'password', content: { Hidden: fixtureValue(key, 'shadow') } },
            { name: 'password', content: { Totp: fixtureValue(key, 'totp') } }], platform_specific: null, custom_icon: null },
        state: mode === 'trash' ? 'Trashed' : mode === 'bad-state' ? 'active' : 'Active',
        flags: [], create_time: 0, modify_time: 0, last_use_time: 0,
      }, attachments: [] }))
    }
  }
}
