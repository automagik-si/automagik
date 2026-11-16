// RFC 0015 (Where the code lives) and RFC 0022 delivery 1L: the Automagik window's chat engine
// is a byte-equal copy of the herdr pack's `mods/pocket-link/chat/`, checked here and (with its
// own herdr patch) in the pack's gate. A change ships herdr first: the plugin copies what the
// pack already has, never the other way around.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(PLUGIN, '..', '..', 'herdr', 'mods', 'pocket-link', 'chat')
const COPY = join(PLUGIN, 'src', 'host', 'live-chat')
const SHARED_VECTORS = join(PLUGIN, '..', '..', 'herdr', 'test', 'fixtures', 'transcript-folder-rule.json')
const COPIED_VECTORS = join(PLUGIN, 'test', 'fixtures', 'transcript-folder-rule.json')

// Every file, by its path in the folder, in a stable order, so a missing or extra file fails too.
function folderFiles(root, at = '') {
  const out = []
  for (const entry of readdirSync(join(root, at), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = at === '' ? entry.name : `${at}/${entry.name}`
    if (entry.isDirectory()) out.push(...folderFiles(root, path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

test('the live-chat copy is byte-equal to the herdr pack folder, file for file', () => {
  const source = folderFiles(SOURCE)
  const copy = folderFiles(COPY)
  assert.deepEqual(copy, source, 'src/host/live-chat has exactly the pack folder\'s files')
  for (const path of source) {
    assert.equal(
      readFileSync(join(COPY, path)).equals(readFileSync(join(SOURCE, path))),
      true,
      `${path} is byte-equal (a change ships herdr first, then this copy)`,
    )
  }
})

test('the copied folder-rule test reads the pack\'s shared vectors, byte for byte', () => {
  // The copied test asks for test/fixtures/transcript-folder-rule.json from its own place; the
  // pack's copy of the rule and am-sidebar's read the same shared file. Keeping a byte copy here
  // lets the byte-equal test folder run in this plugin's CI without changing its bytes.
  assert.equal(readFileSync(COPIED_VECTORS).equals(readFileSync(SHARED_VECTORS)), true,
    'test/fixtures/transcript-folder-rule.json is the pack\'s shared vectors (herdr/test/fixtures)')
})

test('the copy keeps its upstream credit and its Apache-2.0 package marker', () => {
  const upstream = readFileSync(join(COPY, 'UPSTREAM.md'), 'utf8')
  assert.match(upstream, /e1dfc022bd9fb9c49ea831f65d631f4c21405edb/)
  assert.match(upstream, /stablyai\/orca/)
  assert.match(readFileSync(join(COPY, 'LICENSE-upstream'), 'utf8'), /MIT License/)
  assert.equal(JSON.parse(readFileSync(join(COPY, 'package.json'), 'utf8')).license, 'Apache-2.0')
})
