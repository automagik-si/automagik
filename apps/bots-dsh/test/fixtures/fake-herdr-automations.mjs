#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const { FAKE_AUTOMATIONS_STATE: statePath, FAKE_AUTOMATIONS_LOG: logPath,
  FAKE_AUTOMATIONS_VERSION: version = '0.12.1-am.1-fake', FAKE_AUTOMATIONS_SHAPE: shape } = process.env
const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
const [verb, flag] = argv
const am2 = shape === 'am2'
let keys
if (verb === 'put' && (am2 || flag === '--original')) {
  try { keys = Object.keys(JSON.parse(stdin)).sort() } catch { keys = [] }
}
if (logPath) appendFileSync(logPath, JSON.stringify({ argv, stdin: stdin.length > 0, keys }) + '\n')
const { paused = false, scheduler = 0, automations = [], invalid = [], control = {}, history: storedHistory } = JSON.parse(readFileSync(statePath, 'utf8'))
let history = Array.isArray(storedHistory) ? storedHistory : undefined
const save = () => writeFileSync(statePath, JSON.stringify({ paused, scheduler, automations, invalid, control, history }))
const reply = value => writeFileSync(1, JSON.stringify(value) + '\n')
const nextRuns = ['2099-06-01T09:00:00Z', '2099-06-02T09:00:00Z']
const fault = control[verb]
if (fault?.delay) await delay(fault.delay)
if (fault?.stderr) writeFileSync(2, fault.stderr)
if (fault?.exit) process.exit(fault.exit)
if (fault?.overflow) { writeFileSync(2, 'x'.repeat(fault.overflow)); process.exit(0) }
if (fault?.text !== undefined) { writeFileSync(1, fault.text); process.exit(0) }

if (verb === 'version') {
  writeFileSync(1, version + '\n')
} else if (verb === 'ls' && flag === '--json') {
  reply({
    backend: 'auto', config: '/scratch/automations.yaml', state: '/scratch/state',
    paused, scheduler,
    automations: history ? automations.map(row => ({ ...row, last: history.find(run => run?.automation === row.name) ?? null })) : automations,
    invalid,
    ...(shape === 'current' || am2 ? { kinds: ['prompt', 'workflow', 'command'], targets: ['bot', 'worker'] } : {}),
  })
} else if (verb === 'history' && argv.at(-1) === '--json' && [2, 3].includes(argv.length)) {
  reply((history ?? []).filter(row => argv.length === 2 || row?.automation === flag).slice(0, 200))
} else if (verb === 'run' && argv.length === 3 && argv[2] === '--bg') {
  if (control.runAppends && typeof control.runAppends === 'object' && !Array.isArray(control.runAppends)) {
    history ??= []
    history.unshift(control.runAppends)
    save()
  }
} else if ((verb === 'pause' || verb === 'resume') && argv.length === 2) {
  if (flag === '--all') process.exit(2)
  const row = automations.find(row => row.name === flag)
  if (!row) process.exit(1)
  row.disabled = verb === 'pause'
  save()
} else if (verb === 'put' && flag === '--original' && (argv.length === 3 || (argv.length === 4 && argv[3] === '--dry-run'))) {
  const entry = JSON.parse(stdin)
  if (Array.isArray(control.checkEdit) && JSON.stringify(keys) !== JSON.stringify([...control.checkEdit].sort())) process.exit(42)
  const original = argv[2]
  const index = automations.findIndex(row => row.name === original)
  if (index < 0) process.exit(1)
  const candidate = { ...automations[index] }
  for (const key of ['name', 'cron', 'repo', 'workspace', 'prompt', 'timeout_minutes']) {
    if (Object.hasOwn(entry, key)) candidate[key] = entry[key]
  }
  const { name, cron, repo } = candidate
  if (fault?.problem) reply({ problem: fault.problem })
  else if (name !== original && [...automations, ...invalid].some(row => row.name === name)) reply({ problem: `${name}: an automation by that name already exists` })
  else if (!cron?.trim()) reply({ problem: `${name}: missing cron` })
  else if (!repo?.trim()) reply({ problem: `${name}: missing repo` })
  else {
    if (argv[3] !== '--dry-run') {
      automations[index] = candidate
      save()
    }
    reply({ next: nextRuns })
  }
} else if (verb === 'put' && (argv.length === 1 || (argv.length === 2 && flag === '--dry-run'))) {
  const entry = JSON.parse(stdin)
  if (control.checkPut) {
    const keys = ['name', 'cron', 'repo', 'workspace', 'agent', 'prompt', 'timeout_minutes', 'agent_args'].sort()
    if (!stdin.includes('"agent_args":[]') || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(keys)) process.exit(42)
  }
  if (fault?.problem) reply({ problem: fault.problem })
  else if ([...automations, ...invalid].some(row => row.name === entry.name)) reply({ problem: `${entry.name}: an automation by that name already exists` })
  else if (!entry.repo) reply({ problem: `${entry.name}: missing repo` })
  else {
    if (flag !== '--dry-run') {
      automations.push({ ...entry, disabled: false, line: automations.length + 2, last: null, next: nextRuns[0] })
      save()
    }
    reply({ next: nextRuns })
  }
} else if (verb === 'rm' && argv.length === 2) {
  const rows = [automations, invalid].find(list => list.some(row => row.name === flag))
  if (!rows) process.exit(1)
  rows.splice(rows.findIndex(row => row.name === flag), 1)
  save()
} else {
  process.exit(2)
}
