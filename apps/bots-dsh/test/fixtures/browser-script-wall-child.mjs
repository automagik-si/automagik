// Stands in for script-child.js in test/browser-script-wall.test.js. It is plain Node code
// with all of Node in reach, which is what a script that owned its process would have.
// The host starts it exactly as it starts script-child.js, and the start message's body
// names one check. A check is a handful of ordinary, documented calls; the answer says,
// for each, whether this process could make it.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync, appendFileSync, chmodSync, copyFileSync, createReadStream, createWriteStream, mkdirSync, openSync, promises,
  readFileSync, readdirSync, renameSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const say = line => process.stdout.write(`${line}\n`)
const message = value => say(JSON.stringify(value))
const answer = value => message({ type: 'done', answer: JSON.stringify(value), error: null })
// For each call: 'allowed' when it went through, else the code of the error that refused it.
const attempt = async (calls) => {
  const results = {}
  for (const [name, call] of Object.entries(calls)) {
    try {
      await call()
      results[name] = 'allowed'
    } catch (error) {
      results[name] = String(error?.code ?? error)
    }
  }
  return results
}
const opened = stream => new Promise((resolve, reject) => stream.on('open', resolve).on('error', reject))

const checks = {
  // What the process may do. `path` is a file the host can read and change.
  readFile: async ({ path }) => answer(await attempt({
    readFileSync: () => readFileSync(path),
    openSync: () => openSync(path, 'r'),
    statSync: () => statSync(path),
    accessSync: () => accessSync(path),
    readdirSync: () => readdirSync(dirname(path)),
    'promises.readFile': () => promises.readFile(path),
    createReadStream: () => opened(createReadStream(path)),
    createRequire: () => createRequire(path)(path),
    'import()': () => import(pathToFileURL(path).href),
    loadEnvFile: () => process.loadEnvFile(path),
  })),
  writeFile: async ({ path }) => {
    const beside = name => join(dirname(path), name)
    answer(await attempt({
      writeFileSync: () => writeFileSync(beside('written.txt'), 'written'),
      appendFileSync: () => appendFileSync(path, 'appended'),
      openSync: () => openSync(beside('opened.txt'), 'w'),
      truncateSync: () => truncateSync(path, 0),
      chmodSync: () => chmodSync(path, 0o600),
      copyFileSync: () => copyFileSync(path, beside('copied.txt')),
      renameSync: () => renameSync(path, beside('renamed.txt')),
      symlinkSync: () => symlinkSync(path, beside('linked.txt')),
      mkdirSync: () => mkdirSync(beside('folder')),
      unlinkSync: () => unlinkSync(path),
      'promises.writeFile': () => promises.writeFile(beside('promised.txt'), 'written'),
      createWriteStream: () => opened(createWriteStream(beside('streamed.txt'))),
    }))
  },
  // The database module reads and writes files past the file permission. `path` is a
  // database the host made; `fresh` is a file that does not exist yet.
  sqlite: async ({ path, fresh }) => answer(await attempt({
    import: () => import('node:sqlite'),
    builtin: () => {
      if (process.getBuiltinModule('node:sqlite') === undefined) throw new Error('not a builtin')
    },
    read: () => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(path).prepare('select value from kept').get(),
    create: () => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(fresh).exec('create table made (value)'),
  })),
  spawn: async () => answer(await attempt({
    spawnSync: () => {
      const result = spawnSync(process.execPath, ['--version'])
      if (result.error) throw result.error
    },
    execFileSync: () => execFileSync(process.execPath, ['--version']),
    spawn: () => new Promise((resolve, reject) => spawn(process.execPath, ['--version']).on('exit', resolve).on('error', reject)),
    // Last: where it is allowed, it replaces this process and no answer is sent.
    ...(typeof process.execve === 'function' ? { execve: () => process.execve(process.execPath, [process.execPath, '--version'], {}) } : {}),
  })),
  worker: async () => answer(await attempt({ Worker: () => new Worker('', { eval: true }) })),
  addon: async ({ path }) => answer(await attempt({ dlopen: () => process.dlopen({ exports: {} }, path) })),
  wasi: async () => answer(await attempt({ WASI: () => new (process.getBuiltinModule('node:wasi').WASI)({ version: 'preview1' }) })),
  inspector: async () => {
    const inspector = process.getBuiltinModule('node:inspector')
    answer(await attempt({
      open: () => inspector.open(0, '127.0.0.1'),
      Session: () => new inspector.Session().connect(),
    }))
  },
  // Files Node writes for the caller: a report, a heap snapshot.
  diagnostics: async ({ path }) => answer(await attempt({
    writeReport: () => process.report.writeReport(join(path, 'report.json')),
    'writeReport, no path': () => process.report.writeReport(),
    writeHeapSnapshot: () => process.getBuiltinModule('node:v8').writeHeapSnapshot(join(path, 'heap.heapsnapshot')),
    'writeHeapSnapshot, no path': () => process.getBuiltinModule('node:v8').writeHeapSnapshot(),
  })),
  folder: async ({ path }) => answer({ cwd: process.cwd(), ...await attempt({ chdir: () => process.chdir(path) }) }),
  env: () => answer(Object.keys(process.env)),
  // Fills this process's own heap, a few megabytes at a time, up to `megabytes`. With no
  // cap on that heap it gets there and says so.
  heap: ({ megabytes }) => {
    const kept = []
    while (process.memoryUsage().heapUsed < megabytes * 1024 * 1024) kept.push(Array.from({ length: 100_000 }, (_, at) => ({ at })))
    answer({ filled: megabytes, chunks: kept.length })
  },
  // A process that handles the polite stop and so outlives it.
  ignoreStop: () => {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1_000)
  },
  // Lines that are not what script-child.js sends.
  notJson: () => say('not json'),
  notAnObject: () => say('[1]'),
  unknownType: () => message({ type: 'run', command: 'x' }),
  unknownHelper: () => message({ type: 'call', id: 1, name: 'shell', args: '[]' }),
  inheritedHelper: () => message({ type: 'call', id: 1, name: 'constructor', args: '[]' }),
  argsNotText: () => message({ type: 'call', id: 1, name: 'goto', args: ['x'] }),
  argsTooLong: ({ length }) => message({ type: 'call', id: 1, name: 'goto', args: JSON.stringify(['x'.repeat(length)]) }),
  idNotANumber: () => message({ type: 'call', id: 'one', name: 'goto', args: '[]' }),
  answerNotText: () => message({ type: 'done', answer: { text: 'x' }, error: null }),
  errorNotText: () => message({ type: 'done', answer: null, error: 5 }),
  answerOfLength: ({ length }) => message({ type: 'done', answer: 'x'.repeat(length), error: null }),
  errorOfLength: ({ length }) => message({ type: 'done', answer: null, error: 'x'.repeat(length) }),
  // A message with no end: more than the host holds for one line.
  endlessLine: ({ length }) => process.stdout.write('x'.repeat(length)),
}

let held = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  held += chunk
  const at = held.indexOf('\n')
  if (at === -1) return
  const start = JSON.parse(held.slice(0, at))
  held = ''
  if (start.type !== 'start') return
  const request = JSON.parse(start.body)
  checks[request.check](request)
})
process.stdin.on('end', () => process.exit(0))
