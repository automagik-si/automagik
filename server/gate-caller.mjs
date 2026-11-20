import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloudConfig } from './gate-cloud.mjs'
import { readOwner } from './gate-store.mjs'
import { GATE_VIEW_MOUNT } from './lib.mjs'

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const kidOf = x => createHash('sha256').update(Buffer.from(x, 'base64url')).digest().subarray(0, 16).toString('base64url')
const privateKey = d => createPrivateKey({ key: Buffer.from(d, 'base64url'), type: 'pkcs8', format: 'der' })
const canonical = (s, length) => typeof s === 'string' && s.length === length && Buffer.from(s, 'base64url').toString('base64url') === s
const keyDir = dir => join(dir, 'caller')
const keyFile = dir => join(keyDir(dir), 'keys.json')
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants
const rotationActions = ['stage', 'promote', 'retire']
const MAX_TARGET_BYTES = 4096
const MAX_ASSERTION_BYTES = 8192

function directoryPath(path, allowMissing) {
  try { return realpathSync(path) }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error
    // A missing directory can be restored after a rotation. A dangling symlink
    // has no verified destination and must not be treated as a missing directory.
    if (lstatSync(path, { throwIfNoEntry: false })) throw error
    return join(directoryPath(dirname(path), true), basename(path))
  }
}

export function callerKeyDirectories(dir, publicDir, { allowMissing = false } = {}) {
  if (!isAbsolute(publicDir ?? '')) throw new Error('Caller key directory must be absolute')
  const configuredHome = resolve(dir)
  const configuredPublic = resolve(publicDir)
  const home = directoryPath(configuredHome, allowMissing)
  const published = directoryPath(configuredPublic, allowMissing)
  if (!allowMissing && !statSync(published).isDirectory()) throw new Error('Caller key directory is invalid')
  const within = (path, root) => path === root || path.startsWith(root === '/' ? root : root + '/')
  const dsh = directoryPath('/dsh', true)
  if (within(home, published) || within(published, home) ||
      within(configuredPublic, configuredHome) || within(configuredPublic, home) || within(published, configuredHome) ||
      [home, published, configuredHome, configuredPublic].some(path => within(path, '/dsh') || within(path, dsh) ||
        within(path, GATE_VIEW_MOUNT))) {
    throw new Error('Caller key directories are not separate')
  }
  return { dir: home, publicDir: published }
}

export function instanceOf({ env, dir }) {
  return cloudConfig(env)?.workspace ?? readOwner(dir)?.instance_id
}

function newKey() {
  const { publicKey, privateKey: key } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  return { kid: kidOf(x), x, d: key.export({ type: 'pkcs8', format: 'der' }).toString('base64url'), created: new Date().toISOString() }
}

function atomicWrite(file, value, mode) {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(temp, 'wx', mode)
  try {
    try { fchmodSync(fd, mode); writeFileSync(fd, `${JSON.stringify(value)}\n`) }
    finally { closeSync(fd) }
    renameSync(temp, file)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
}

function openStoreDir(dir, create = false) {
  const folder = keyDir(resolve(dir))
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 })
  let stat = lstatSync(folder, { throwIfNoEntry: false })
  if (!stat && create) {
    try { mkdirSync(folder, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    stat = lstatSync(folder)
  }
  if (!stat) return undefined
  if (!stat.isDirectory() || realpathSync(folder) !== keyDir(realpathSync(dir))) throw new Error('Invalid caller key directory')
  return openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
}

function withLock(dir, fn) {
  const folder = keyDir(dir)
  const guard = openStoreDir(dir, true)
  // Use the stable directory inode to serialize reclaiming a stale .lock along
  // with all other operations. The lease also survives a suspended process.
  try {
    fchmodSync(guard, 0o700)
    const flock = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', guard],
    })
    if (flock.status !== 0) throw new Error('Caller key store is locked')
    const file = join(folder, '.lock')
    let fd
    try { fd = openSync(file, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() - lstatSync(file).mtimeMs <= 30_000) throw new Error('Caller key store is locked')
      unlinkSync(file)
      fd = openSync(file, 'wx', 0o600)
    }
    try { return fn() }
    finally { closeSync(fd); unlinkSync(file) }
  } finally {
    closeSync(guard)
  }
}

function withStoreFile(dir, fn) {
  const folder = openStoreDir(dir)
  if (folder === undefined) return undefined
  try {
    let fd
    try { fd = openSync(keyFile(dir), O_RDONLY | O_NOFOLLOW | O_NONBLOCK) }
    catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('Invalid caller key file')
      return fn(fd, stat)
    } finally {
      closeSync(fd)
    }
  } finally {
    closeSync(folder)
  }
}

function readStore(dir) {
  const state = withStoreFile(dir, fd => JSON.parse(readFileSync(fd, 'utf8')))
  if (state === undefined) return undefined
  if (state?.version !== 1 || !Array.isArray(state.keys) || state.keys.length < 1 || state.keys.length > 2 ||
      (state.pending !== undefined && !rotationActions.includes(state.pending)) ||
      (state.promoted !== undefined && !Number.isSafeInteger(state.promoted))) throw new Error('Invalid caller key store')
  const ids = new Set()
  for (const key of state.keys) {
    if (!canonical(key?.x, 43) || key.kid !== kidOf(key.x) || ids.has(key.kid) ||
        typeof key.created !== 'string' || !Number.isFinite(Date.parse(key.created)) ||
        !canonical(key.d, 64)) {
      throw new Error('Invalid caller key store')
    }
    const pub = createPublicKey(privateKey(key.d)).export({ format: 'jwk' })
    if (pub.crv !== 'Ed25519' || pub.x !== key.x) throw new Error('Invalid caller key material')
    ids.add(key.kid)
  }
  if (!ids.has(state.signer)) throw new Error('Invalid caller signer')
  return state
}

function loadUnlocked(dir) {
  const existing = readStore(dir)
  if (existing) return existing
  const key = newKey()
  const state = { version: 1, signer: key.kid, keys: [key] }
  atomicWrite(keyFile(dir), state, 0o600)
  return state
}

export function loadCallerKeys(dir) {
  return readStore(dir) ?? withLock(dir, () => loadUnlocked(dir))
}

function publicKeys(state, instance) {
  return { version: 1, instance, keys: state.keys.map(({ kid, x }) => ({ kid, alg: 'EdDSA', crv: 'Ed25519', x })) }
}

function publishUnlocked(publicDir, state, instance) {
  const file = join(publicDir, 'caller-keys.json')
  const data = publicKeys(state, instance)
  try {
    if (readFileSync(file, 'utf8') === `${JSON.stringify(data)}\n`) return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  atomicWrite(file, data, 0o644)
}

function finishPublication(dir, publicDir, state, instance, now) {
  publishUnlocked(publicDir, state, instance)
  if (state.pending !== undefined) {
    if (state.pending === 'promote') state.promoted = now()
    delete state.pending
    atomicWrite(keyFile(dir), state, 0o600)
  }
}

const stampOf = dir => withStoreFile(dir,
  (_, { ino, size, ctimeMs, mtimeMs }) => `${ino}:${size}:${ctimeMs}:${mtimeMs}`)

export function createSigner({ dir, publicDir, instance, now = Date.now, monotonicNow = () => performance.now(), random = randomBytes }) {
  let state, stamp, signingKey
  let checkedAt = -Infinity
  let published
  const install = (next, nextStamp) => {
    signingKey = privateKey(next.keys.find(key => key.kid === next.signer).d)
    state = next
    stamp = nextStamp
  }
  const publish = (id = instance()) => {
    if (!id) return
    withLock(dir, () => {
      const next = loadUnlocked(dir)
      finishPublication(dir, publicDir, next, id, now)
      install(next, stampOf(dir))
      published = JSON.stringify(publicKeys(state, id))
      checkedAt = monotonicNow()
    })
  }
  return {
    publish,
    sign({ principal, familyId, method, path }) {
      const aud = instance()
      if (!aud || principal.workspace !== aud || principal.roles.some(role => role === 'owner' || role === 'admin')) {
        throw new Error('Caller is outside the signing scope')
      }
      const elapsed = monotonicNow()
      if (state && elapsed - checkedAt >= 1000) {
        const nextStamp = stampOf(dir)
        if (stamp !== nextStamp) install(readStore(dir), nextStamp)
        checkedAt = elapsed
      }
      if (!state || state.pending || published !== JSON.stringify(publicKeys(state, aud))) publish(aud)
      const { issuer, subject, roles, workspace } = principal
      const iat = Math.floor(now() / 1000)
      const session = createHash('sha256').update(familyId).digest('base64url')
      const nonce = random(16).toString('base64url')
      const h = encode({ alg: 'EdDSA', kid: state.signer, typ: 'automagik-caller' })
      const p = encode({ version: 1, aud, principal: { issuer, subject, roles, workspace }, session, method, path, iat, exp: iat + 30, nonce })
      const input = `${h}.${p}`
      if (input.length + 87 > MAX_ASSERTION_BYTES || Buffer.byteLength(path) > MAX_TARGET_BYTES || !/^[A-Z]{1,16}$/.test(method)) throw new Error('Invalid caller target')
      return `${input}.${edSign(null, Buffer.from(input), signingKey).toString('base64url')}`
    },
  }
}

export function rotateCallerKeys({ dir, publicDir, instance, action, emergency = false, now = Date.now }) {
  if (!rotationActions.includes(action) || (emergency && action !== 'retire')) throw new Error('Invalid rotation command')
  if (instance && (typeof publicDir !== 'string' || !isAbsolute(publicDir))) throw new Error('Caller key directory must be absolute')
  withLock(dir, () => {
    const state = loadUnlocked(dir)
    if (state.pending !== undefined) {
      if (state.pending !== action || !instance) throw new Error('Caller key publication is pending')
      finishPublication(dir, publicDir, state, instance, now)
      return
    }
    const other = state.keys.find(key => key.kid !== state.signer)
    if (action === 'stage') {
      if (other) throw new Error('Second caller key already staged')
      state.keys.push(newKey())
    } else if (!other) {
      throw new Error('Rotation needs two caller keys')
    } else if (action === 'promote') {
      if (state.promoted !== undefined) throw new Error('Second caller key already promoted')
      state.signer = other.kid
      if (!instance) state.promoted = now()
    } else {
      if (!emergency && state.promoted !== undefined && now() - state.promoted < 120_000) {
        throw new Error('Wait 120 seconds after promotion or use retire --now')
      }
      state.keys = state.keys.filter(key => key.kid === state.signer)
      delete state.promoted
    }
    if (instance) state.pending = action
    atomicWrite(keyFile(dir), state, 0o600)
    if (instance) finishPublication(dir, publicDir, state, instance, now)
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [action, flag, ...extra] = process.argv.slice(2)
    const env = process.env
    const dir = env.AUTOMAGIK_GATE_HOME || '/data'
    if ((flag !== undefined && flag !== '--now') || extra.length) throw new Error('Invalid rotation arguments')
    const paths = callerKeyDirectories(dir, env.AUTOMAGIK_GATE_CALLER_PUBLIC, { allowMissing: true })
    rotateCallerKeys({ ...paths, instance: instanceOf({ env, dir: paths.dir }), action, emergency: flag === '--now' })
    console.log(`automagik-gate: caller key ${action} complete`)
  } catch {
    console.error('automagik-gate: caller key rotation refused; see server/README.md')
    process.exitCode = 1
  }
}
