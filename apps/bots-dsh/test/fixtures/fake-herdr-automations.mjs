#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const { FAKE_AUTOMATIONS_STATE: statePath, FAKE_AUTOMATIONS_LOG: logPath,
  FAKE_AUTOMATIONS_VERSION: version = '0.12.1-am.1-fake', FAKE_AUTOMATIONS_SHAPE: shape } = process.env
const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
if (logPath) appendFileSync(logPath, JSON.stringify({ argv, stdin: stdin.length > 0 }) + '\n')
const { paused = false, scheduler = 0, automations = [], invalid = [], control = {} } = JSON.parse(readFileSync(statePath, 'utf8'))
const save = () => writeFileSync(statePath, JSON.stringify({ paused, scheduler, automations, invalid, control }))
const reply = value => writeFileSync(1, JSON.stringify(value) + '\n')
const [verb, flag] = argv
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
    paused, scheduler, automations, invalid,
    ...(shape === 'current' ? { kinds: ['prompt', 'workflow', 'command'], targets: ['bot', 'worker'] } : {}),
  })
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
    const next = ['2099-06-01T09:00:00Z', '2099-06-02T09:00:00Z']
    if (flag !== '--dry-run') {
      automations.push({ ...entry, disabled: false, line: automations.length + 2, last: null, next: next[0] })
      save()
    }
    reply({ next })
  }
} else if (verb === 'rm' && argv.length === 2) {
  const rows = [automations, invalid].find(list => list.some(row => row.name === flag))
  if (!rows) process.exit(1)
  rows.splice(rows.findIndex(row => row.name === flag), 1)
  save()
} else {
  process.exit(2)
}
