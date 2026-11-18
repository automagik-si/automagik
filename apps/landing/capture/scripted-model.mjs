// The capture's stand-in for an AI provider: an Anthropic-Messages-compatible server on
// loopback that answers with a fixed English script for the fictional Northwind scenario.
// The app, its plugins, their tools and every tool's effect are real; only the model's
// words and tool choices come from this file. Nothing here reaches the network.
//
// Environment: SCRIPT_PORT (0 = any free port), SCRIPT_LOG (JSONL of every request).
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.SCRIPT_PORT ?? 0)
const LOG = process.env.SCRIPT_LOG
let seq = 0

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => (block.type === 'text' ? block.text : block.type === 'tool_result' ? textOf(block.content) : '')).join('\n') : ''
const systemText = system => typeof system === 'string' ? system
  : Array.isArray(system) ? system.map(block => block.text ?? '').join('\n') : ''
const text = value => ({ type: 'text', text: value })
const tool = (name, input) => ({ type: 'tool_use', name, input })

// The conversation since the person's last message: the tool calls already made for it.
function turn(messages) {
  const at = messages.findLastIndex(message => message.role === 'user' && !(Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')))
  const asked = at === -1 ? '' : textOf(messages[at].content)
  const calls = messages.slice(at + 1).filter(message => message.role === 'assistant')
    .flatMap(message => (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_use'))
  const results = messages.slice(at + 1).flatMap(message => (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result'))
  return { asked, calls, results }
}

// Summary requests (handoff notes, checkpoints, compaction) get a plain short answer.
const SUMMARY = ['You are now writing a handoff note', 'You are now writing a checkpoint', 'You are now acting as a compaction engine']

// The person's request, as Pip passes it on and as Genie grants it.
export const REQUEST = 'Customers keep asking for their Northwind orders as a spreadsheet. Can Genie add a CSV export to the orders report?'
export const WISH = {
  title: 'CSV export',
  wish: 'Add a CSV export to the Northwind orders report. Add `toCsv(orders)` in src/csv.js (header id,customer,total; quote any field that holds a comma or a quote), a test for a customer name with a comma, and an `npm run export` script that prints the orders as CSV. Run the project\'s tests, commit on the wish branch, and end with a short report.',
}
const BRANCH = /wish\/[a-z0-9][a-z0-9-]*/

// The wish thread's steps: each a real shell command in the wish's own clone.
const STEPS = [
  ['Reading the report module and the project\'s scripts first.', 'Read the report and scripts', 'cat src/report.js package.json'],
  ['Adding `toCsv`, its test and the export script.', 'Add the CSV export and its test', [
    "cat > src/csv.js <<'EOF'",
    "const quote = value => (/[\",\\n]/.test(String(value)) ? `\"${String(value).replaceAll('\"', '\"\"')}\"` : String(value))",
    '',
    'export function toCsv(orders) {',
    "  const header = ['id', 'customer', 'total']",
    "  return [header.join(','), ...orders.map(order => header.map(key => quote(order[key])).join(','))].join('\\n')",
    '}',
    'EOF',
    "cat > src/export.js <<'EOF'",
    "import { toCsv } from './csv.js'",
    "import { orders } from './report.js'",
    '',
    'console.log(toCsv(orders))',
    'EOF',
    "cat > test/csv.test.js <<'EOF'",
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { toCsv } from '../src/csv.js'",
    '',
    "test('quotes a customer name with a comma', () => {",
    "  assert.equal(toCsv([{ id: 7, customer: 'Alfreds, Futterkiste', total: 42.5 }]), 'id,customer,total\\n7,\"Alfreds, Futterkiste\",42.5')",
    '})',
    'EOF',
    'npm pkg set scripts.export="node src/export.js"',
    'git status --short',
  ].join('\n')],
  ['Running the project\'s own checks, then the export itself.', 'Run the tests and the export', 'npm test 2>&1 | grep -E "^(✔|✖|ℹ (tests|pass|fail) )"; npm run -s export'],
  ['Committing on the wish branch.', 'Commit on the wish branch', 'git add -A && git commit -qm "feat(report): export orders as CSV" && git log --oneline -1 && git branch --show-current'],
]

function identity(system) {
  return /You are ([^,\n]+), a Bot on the user's team/.exec(system)?.[1]
}

function pip({ asked, calls, results }) {
  if (asked.startsWith('[Bot team setup]')) return [text('Hi, I\'m Pip! I run your team: Genie takes the project work, and whoever you add next takes the rest. Come to me for anything that needs a decision.\n\nWhat should the team start on?')]
  if (asked.includes('Can Genie add a CSV export')) {
    if (calls.length === 0) return [text('Good one for Genie. Passing it on.'), tool('message_bot', { to: 'Genie', message: `From the user: ${REQUEST} Grant it as a wish in Northwind and tell me when it is running.`, reply_to: 'me' })]
    return [text('Asked Genie. It works in its own copy of Northwind, so nothing changes in your project until you merge. I\'ll tell you when the wish is running.')]
  }
  const branch = BRANCH.exec(asked)?.[0]
  if (branch) return [text(`Genie granted it: the CSV export is running as its own thread on \`${branch}\`. Its report goes to Genie's chat when it ends, and merging stays your call.`)]
  return [text('Noted.')]
}

function genie({ asked, calls, results }) {
  if (asked.startsWith('[Bot team setup]')) return [text('Hi, I\'m Genie. I grant wishes in **northwind**: each one runs in its own copy of the project, on its own branch, and its report comes back here.\n\nWhat should I build first?')]
  if (asked.includes('Can Genie add a CSV export')) {
    if (calls.length === 0) return [text('Granting it as a wish.'), tool('grant_wish', WISH)]
    const branch = BRANCH.exec(results.map(result => textOf(result.content)).join('\n'))?.[0] ?? 'its wish branch'
    return [text(`Granted: **${WISH.title}** is running as its own thread on \`${branch}\`. Its report comes back to my chat.`)]
  }
  const branch = BRANCH.exec(asked)?.[0]
  if (branch) return [text(`**${WISH.title}** is done. \`${branch}\` is back in Northwind with one commit: \`toCsv\` in src/csv.js, a test for names with commas, and \`npm run export\`. The tests pass.\n\nNothing was pushed or merged. Look it over and merge it when you're happy.`)]
  return [text('Noted.')]
}

function wishThread(tools, { asked, calls, results }) {
  const shell = ['bash', 'shell', 'exec_command'].find(name => tools.some(entry => entry.name === name))
  if (calls.length < STEPS.length) {
    const [say, description, command] = STEPS[calls.length]
    return [text(say), tool(shell, { command, description })]
  }
  const branch = BRANCH.exec(results.map(result => textOf(result.content)).join('\n'))?.[0] ?? BRANCH.exec(asked)?.[0] ?? 'the wish branch'
  // The report states what the thread's own test run printed, never more.
  const run = textOf(results[2]?.content)
  const passed = Number(/ℹ pass (\d+)/.exec(run)?.[1] ?? NaN)
  const failedTests = Number(/ℹ fail (\d+)/.exec(run)?.[1] ?? NaN)
  const checks = failedTests === 0 && passed > 0 ? `\`npm test\` passes (${passed} tests)` : '`npm test` did not pass: see the run above'
  return [text(`## Report\n\n**Done.** \`${branch}\` adds a CSV export to the orders report.\n\n- \`src/csv.js\`: \`toCsv(orders)\`, quoting fields with commas or quotes\n- \`src/export.js\` and \`npm run export\`: print the orders as CSV\n- \`test/csv.test.js\`: a customer name with a comma\n\nChecks: ${checks}. One commit on \`${branch}\`; not pushed or merged.`)]
}

function decide(body) {
  const messages = body.messages ?? []
  const tools = body.tools ?? []
  const system = systemText(body.system)
  const lastText = textOf(messages.at(-1)?.content)
  if (SUMMARY.some(prompt => lastText.includes(prompt))) return [text('## Summary\nNorthwind: the CSV export wish was granted and reported.')]
  const state = turn(messages)
  const who = identity(system)
  if (who === 'Pip') return pip(state)
  if (who === 'Genie') return genie(state)
  if (state.asked.includes('toCsv(orders)') || messages.some(message => textOf(message.content).includes('toCsv(orders)') && message.role === 'user')) return wishThread(tools, state)
  // Titles and anything else unscripted.
  if (tools.length === 0) return [text('Northwind CSV export')]
  return [text('Noted.')]
}

function sse(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path.endsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ type: 'model', id: 'scripted-model', display_name: 'Scripted Model' }], has_more: false }))
    return
  }
  if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw)
    const id = ++seq
    const out = decide(body)
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ id, session: req.headers['x-deepseek-harness-session-id'] ?? null, stream: body.stream !== false, tools: (body.tools ?? []).map(entry => entry.name ?? entry.type), system: systemText(body.system).slice(0, 300), messages: body.messages?.length ?? 0, last: textOf(body.messages?.at(-1)?.content).slice(0, 2000), out })}\n`)
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `script-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'scripted-model', content: out, stop_reason: out.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 400, output_tokens: 60 } }))
      return
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(res, { type: 'message_start', message: { id: `script-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'scripted-model', content: [], usage: { input_tokens: 400, output_tokens: 0 } } })
      let usedTool = false
      out.forEach((block, index) => {
        if (block.type === 'text') {
          sse(res, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
        } else {
          usedTool = true
          sse(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${id}-${index}`, name: block.name, input: {} } })
          sse(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        }
        sse(res, { type: 'content_block_stop', index })
      })
      sse(res, { type: 'message_delta', delta: { stop_reason: usedTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } })
      sse(res, { type: 'message_stop' })
      res.end()
    }, 120)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`scripted model on http://127.0.0.1:${server.address().port}/v1`))
