// #1544: a Bot on an agent over ACP (acp-codex) once answered "open this page in the Bot
// Browser" by launching the system Chrome, because it had no DSH tools at all. The bridge now
// offers the browser tools; this pins the instruction that goes with them, on the description
// the agent reads before it calls one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolDefs } from '../src/host/browser/refs.js'

test('browser_open sends an ACP Bot to its own browser, never the system Chrome, with a browse handoff', () => {
  const open = toolDefs.find(tool => tool.name === 'browser_open')
  assert.ok(open, 'the default browser plugin defines browser_open')
  assert.match(open.description, /never launch the system Chrome or another browser from a command/)
  assert.match(open.description, /Bot named browse with message_bot/)
  assert.match(open.description, /Use this tool for every page the user asks you to open/)
})
