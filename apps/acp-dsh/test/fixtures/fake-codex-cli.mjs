#!/usr/bin/env node
// #1564 PR B (BD-4): a stand-in codex-acp for index.js's OFF spawn branch. Only its `cli`
// passthrough answers, from the codex-0.171 captures (as codex-native-world.js's fakeCodex):
// the Codex home's own default model is gpt-5.5, which shows no tool block. It never starts
// a Codex, reads no Codex home and writes nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const at = process.argv.indexOf('cli')
if (at < 0) process.exit(0)
const fixture = name => readFileSync(join(import.meta.dirname, 'codex-0.171', name), 'utf8')
const rest = process.argv.slice(at + 1)
const words = []
const config = []
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === '-c') { config.push(rest[i + 1]); i += 1 } else words.push(rest[i])
}
const what = words.join(' ')
const has = text => config.some(entry => entry.includes(text))
const model = config.find(entry => entry.startsWith('model='))?.slice(6).replace(/^'|'$/g, '')
let stdout = ''
if (what === 'mcp list --json') stdout = '[]'
else if (what === 'features list') stdout = fixture('features.txt')
else if (what === 'debug models') stdout = fixture('models.json')
else if (what === 'debug prompt-input') {
  const undone = has('shell_tool = true') ? 'shell_tool' : has('view_image = true') ? 'view_image'
    : !has('model_catalog_json=') ? 'catalog' : has('disable_native_tools = false') ? 'collaboration'
      : has('experimental_request_user_input = { enabled = true }') ? 'user_input' : undefined
  stdout = model === undefined ? fixture('prompt-model-gpt-5.5.json')
    : undone !== undefined ? fixture(`prompt-undo-${undone}.json`) : fixture(`prompt-model-${model}.json`)
}
process.stdout.write(stdout)
