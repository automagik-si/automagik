// Proof for the typing piece (RFC 0030 delivery 2's first half): a line typed from the app's
// own service arrives in a real herdr-core pane. The pane is a scratch one: its own HC_SESSION,
// its own XDG folders, a made-up project and a made-up Bot; never a real team's seat.
//
//   node dev/code-side-typing-proof.mjs
//
// Prints the address created, the line the pane echoed back and the record rows (which hold no
// keys). Stops the terminal and the scratch core at the end, and removes its temp home.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectCore } from '../src/host/code-core.js'
import { createTypingService } from '../src/host/code-typing.js'

const BOT = 'b-aaaaaaaaaa'
const CORE_BIN = process.env.HERDR_TEST_HC || join(process.env.HOME || '', '.local', 'bin', 'herdr-core')
const root = mkdtempSync(join(tmpdir(), 'code-typing-proof-'))
const project = join(root, 'project')
const automagikHome = join(root, 'automagik')
const appHome = join(root, 'herdr-app')
const ledgerDir = join(appHome, 'automagik-herdr')
const recordPath = join(root, 'typing.jsonl')
const run = join(root, 'run')
for (const dir of [project, join(automagikHome, 'bots'), ledgerDir, run]) mkdirSync(dir, { recursive: true })
chmodSync(run, 0o700)
const session = `code-typing-proof-${Math.random().toString(36).slice(2, 10)}`
const env = {
  ...process.env,
  HC_SESSION: session,
  XDG_STATE_HOME: join(root, 'state'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_RUNTIME_DIR: run,
  AUTOMAGIK_HOME: automagikHome,
  HERDR_APP_HOME: appHome,
  HERDR_HC: CORE_BIN,
}

const core = await connectCore({ env })
let address = null
try {
  const coreId = core.info?.core?.id
  if (!coreId) throw new Error('the scratch core gave no id')
  const made = await core.call('terminal.run', { argv: ['sh', '-c', "printf 'scratch-pane ready\\r\\n'; exec cat"], cwd: project, name: 'typing-proof', labels: { 'automagik.proof': '1' } })
  address = made.address
  console.log(`scratch core ${coreId}, terminal ${address}, project ${project}`)
  // A made-up Bot in a made-up project, bound to the scratch terminal the way the CLI binds.
  writeFileSync(join(automagikHome, 'bots', 'bots.json'), JSON.stringify({ version: 2, projects: [{ folder: project }], bots: [{ id: BOT, name: 'Proof Bot', main: true, folder: project }] }))
  const at = new Date().toISOString()
  writeFileSync(join(ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: BOT, project, terminal: address, core: coreId, created_ms: made.created_ms, machine: null, at, by: 'start' })}\n`)
  writeFileSync(join(ledgerDir, 'workers.jsonl'), '')

  const typing = createTypingService({ env, recordPath, admit: () => ({}) })
  // Let the scratch shell paint once before typing into it, as a person does.
  for (let i = 0; i < 40; i += 1) {
    const painted = (await core.call('terminal.read', { terminal: address, lines: 5 }))?.text ?? ''
    if (painted.includes('scratch-pane ready')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const taken = await typing.take({ request: { headers: new Headers() }, bot: BOT, viewer: 'proof-viewer-1' })
  if (taken.status !== 200) throw new Error(`take refused: ${taken.status} ${JSON.stringify(taken.body)}`)
  const line = 'typed from the app, made-up line'
  const typed = await typing.input({ request: { headers: new Headers() }, session: taken.body.session, data: Buffer.from(`${line}\r`, 'utf8').toString('base64') })
  if (typed.status !== 204) throw new Error(`input refused: ${typed.status}`)
  // Read the pane through the core until the line is on its screen.
  let screen = ''
  const until = Date.now() + 8000
  while (Date.now() < until) {
    const read = await core.call('terminal.read', { terminal: address, lines: 20 })
    screen = read?.text ?? ''
    if (screen.includes(line)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log(`typed line arrived in the real pane: ${screen.includes(line)}`)
  if (!screen.includes(line)) throw new Error('the typed line did not arrive in the scratch pane')
  const paste = 'pasted-without-enter'
  await typing.input({ request: { headers: new Headers() }, session: taken.body.session, data: Buffer.from(paste, 'utf8').toString('base64') })
  await new Promise(resolve => setTimeout(resolve, 400))
  const after = (await core.call('terminal.read', { terminal: address, lines: 20 }))?.text ?? ''
  console.log(`paste reached the pane, and no Enter was pressed by itself: ${after.includes(paste)}`)
  await typing.release({ request: { headers: new Headers() }, session: taken.body.session })
  await typing.dispose()
  const record = readFileSync(recordPath, 'utf8').trim().split('\n')
  console.log(`record rows: ${record.length}`)
  for (const row of record) console.log(`  ${row}`)
  if (record.some(row => row.includes(line) || row.includes(paste))) throw new Error('a keystroke reached the record')
  console.log('the record holds no keystrokes: true')
} catch (error) {
  console.error(`proof failed: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  try { if (address) await core.call('terminal.kill', { terminal: address }) } catch { /* already gone */ }
  try { await core.call('server.stop') } catch { /* already stopped */ }
  core.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
