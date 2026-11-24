// Bakes every look, 33 characters in 19 inks, into a bots home and reports the time it took
// and the size of one folder.
//
//   node scripts/bake-all.mjs <bots home> [--jobs 4]
//
// The home is required, so a trial run never lands in the real ~/.automagik/bots by accident.
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { allLookIds } from '../src/art.js'
import { bakePet } from '../src/bake.js'

const args = process.argv.slice(2)
const home = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : undefined
if (!home) {
  console.error('usage: node scripts/bake-all.mjs <bots home> [--jobs 4]')
  process.exit(2)
}
const at = args.indexOf('--jobs')
const jobs = Math.max(1, Number(at > 0 ? args[at + 1] : 4) || 4)

async function sizeOf(dir) {
  let bytes = 0
  let files = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = await sizeOf(path)
      bytes += inner.bytes
      files += inner.files
    } else {
      bytes += (await stat(path)).size
      files += 1
    }
  }
  return { bytes, files }
}

const ids = allLookIds()
const failures = []
let next = 0
let done = 0
const started = performance.now()
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < ids.length) {
    const id = ids[next]
    next += 1
    try {
      await bakePet(id, { home })
    } catch (error) {
      failures.push(`${id}: ${error.message}`)
    }
    done += 1
    if (done % 50 === 0) console.error(`${done}/${ids.length}`)
  }
}))
const seconds = (performance.now() - started) / 1000
const sample = 'kitty-blue'
const { bytes, files } = await sizeOf(join(home, 'pets', sample))
const total = await sizeOf(join(home, 'pets'))
console.log(`${ids.length - failures.length}/${ids.length} looks baked in ${seconds.toFixed(1)}s (${(seconds / ids.length).toFixed(2)}s each, ${jobs} at a time) into ${join(home, 'pets')}`)
console.log(`${sample}: ${(bytes / 1024).toFixed(0)} KiB in ${files} files; all looks: ${(total.bytes / 1024 / 1024).toFixed(1)} MiB`)
for (const failure of failures) console.error(`failed: ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)
