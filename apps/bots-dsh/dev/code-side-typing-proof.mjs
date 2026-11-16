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
import { BRACKET_PASTE_ON, pasteBytes } from '../src/client/code-side-paste.js'

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

  // A real scratch shell, twice: without bracketed paste the guard must leave no CR or LF in
  // the paste (so nothing runs); with bracketed paste on, the paste goes inside the markers
  // and the program takes it as text only.
  const pasteProof = async ({ label, argv, text, bracketed }) => {
    const made = await core.call('terminal.run', { argv, cwd: project, name: `proof-${label}`, keep: true })
    const terminal = made.address
    writeFileSync(join(ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: BOT, project, terminal, core: coreId, created_ms: made.created_ms, machine: null, at: new Date().toISOString(), by: 'start' })}\n`)
    const seen = []
    const watcher = await connectCore({ env })
    const attached = await watcher.attach({ terminal, cols: made.cols ?? 80, rows: made.rows ?? 24, history: 0, observe: true })
    watcher.watch(attached.channel, { onData: (bytes) => { seen.push(bytes.toString('latin1')); watcher.credit(attached.channel, bytes.length) }, onClose: () => {} })
    const readyUntil = Date.now() + 5000
    while (Date.now() < readyUntil && !(await core.call('terminal.read', { terminal, lines: 5 }))?.text?.includes('$')) await new Promise(resolve => setTimeout(resolve, 50))
    const marker = bracketed ? BRACKET_PASTE_ON : null
    if (marker) {
      const untilMarker = Date.now() + 5000
      while (Date.now() < untilMarker && !seen.join('').includes(marker)) await new Promise(resolve => setTimeout(resolve, 50))
      if (!seen.join('').includes(marker)) throw new Error(`${label}: the program did not turn on bracketed paste`)
    }
    const taken = await typing.take({ request: { headers: new Headers() }, bot: BOT, viewer: `proof-${label}` })
    if (taken.status !== 200) throw new Error(`${label}: take refused ${taken.status}`)
    const { bytes, note } = pasteBytes(text, bracketed)
    const answer = await typing.input({ request: { headers: new Headers() }, session: taken.body.session, data: Buffer.from(bytes).toString('base64') })
    if (answer.status !== 204) throw new Error(`${label}: paste input refused ${answer.status}`)
    await new Promise(resolve => setTimeout(resolve, 1600))
    const screen = (await core.call('terminal.read', { terminal, lines: 30 }))?.text ?? ''
    const ran = screen.split('\n').some(line => line.trim() === text.split(/\r?\n/)[0].replace(/^echo /, '').trim())
    console.log(`${label}: sent note=${note} ran=${ran} screenHasText=${screen.includes(text.split(/\r?\n/)[0].trim())}`)
    if (ran) throw new Error(`${label}: the paste ran a command`)
    await typing.release({ request: { headers: new Headers() }, session: taken.body.session })
    watcher.detach(attached.channel); watcher.close()
    await core.call('terminal.kill', { terminal }).catch(() => {})
    return { label, note, ran }
  }
  const plain = await pasteProof({ label: 'sh-no-bracketed', argv: ['sh', '-i'], text: 'echo PASTED\n', bracketed: false })
  if (plain.note !== 'line-breaks-stripped') throw new Error('without bracketed paste a multi-line paste must be stripped')
  const bracketed = await pasteProof({ label: 'bash-bracketed', argv: ['bash', '--norc', '--noprofile', '-i'], text: 'echo BRACKETED\n', bracketed: true })
  // The breakout: a paste that carries the bracketed-paste end marker of its own. The guard
  // strips its ESC, so the marker is plain text and nothing after it can run.
  const breakout = async () => {
    const made = await core.call('terminal.run', { argv: ['bash', '--norc', '--noprofile', '-i'], cwd: project, name: 'proof-breakout', keep: true })
    const terminal = made.address
    writeFileSync(join(ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: BOT, project, terminal, core: coreId, created_ms: made.created_ms, machine: null, at: new Date().toISOString(), by: 'start' })}\n`)
    const seen = []
    const watcher = await connectCore({ env })
    const attached = await watcher.attach({ terminal, cols: made.cols ?? 80, rows: made.rows ?? 24, history: 0, observe: true })
    watcher.watch(attached.channel, { onData: (bytes) => { seen.push(bytes.toString('latin1')); watcher.credit(attached.channel, bytes.length) }, onClose: () => {} })
    const untilMarker = Date.now() + 5000
    while (Date.now() < untilMarker && !seen.join('').includes(BRACKET_PASTE_ON)) await new Promise(resolve => setTimeout(resolve, 50))
    if (!seen.join('').includes(BRACKET_PASTE_ON)) throw new Error('breakout: bash did not turn on bracketed paste')
    const untilPrompt = Date.now() + 5000
    while (Date.now() < untilPrompt && !(await core.call('terminal.read', { terminal, lines: 5 }))?.text?.includes('$')) await new Promise(resolve => setTimeout(resolve, 50))
    const taken = await typing.take({ request: { headers: new Headers() }, bot: BOT, viewer: 'proof-breakout' })
    if (taken.status !== 200) throw new Error(`breakout: take refused ${taken.status}`)
    const payload = 'x' + '\u001b[201~' + 'echo BROKE\n'
    const { bytes, note } = pasteBytes(payload, true)
    const answer = await typing.input({ request: { headers: new Headers() }, session: taken.body.session, data: Buffer.from(bytes).toString('base64') })
    if (answer.status !== 204) throw new Error(`breakout: input refused ${answer.status}`)
    await new Promise(resolve => setTimeout(resolve, 1600))
    const screen = (await core.call('terminal.read', { terminal, lines: 30 }))?.text ?? ''
    const ran = screen.split('\n').some(line => line.trim() === 'BROKE')
    console.log(`bracketed-breakout: note=${note} ran=${ran} screenHasText=${screen.includes('BROKE')}`)
    if (ran) throw new Error('breakout: the pasted end marker ran the rest')
    await typing.release({ request: { headers: new Headers() }, session: taken.body.session })
    watcher.detach(attached.channel); watcher.close()
    await core.call('terminal.kill', { terminal }).catch(() => {})
  }
  await breakout()
  console.log('the record holds no keystrokes: true')
  console.log(`paste proof: ${plain.label} stripped its line breaks and ran nothing; ${bracketed.label} took the markers and ran nothing; the bracketed-breakout paste ran nothing`)
} catch (error) {
  console.error(`proof failed: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  try { if (address) await core.call('terminal.kill', { terminal: address }) } catch { /* already gone */ }
  try { await core.call('server.stop') } catch { /* already stopped */ }
  core.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
