#!/usr/bin/env node
// The operator command for RFC 0014's seed: turns one project's Herdr v1 roster into the two
// version 2 registry files. The logic (and its report) is `src/host/registry-seed.js`; this file
// only parses the two flags and sets the exit code. It ships in the plugin's package files, so
// the same path runs from a checkout and inside the server image's installed plugin:
//
//   node apps/bots-dsh/scripts/seed-registry.mjs --project <folder> --home <automagik-home>
//   node /opt/automagik/profile/node_modules/@automagik/bots-dsh/scripts/seed-registry.mjs \
//     --project /data/workspace --home /data
import { USAGE, defaultHome, folderOf, formatSeedReport, seedRegistry } from '../src/host/registry-seed.js'

class UsageError extends Error {}

function parseArgs(argv) {
  let project = process.cwd()
  let home = defaultHome()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--project' || arg === '--home') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('-')) throw new UsageError(`${arg} needs a folder`)
      index += 1
      if (arg === '--project') project = folderOf(value)
      else home = folderOf(value)
      continue
    }
    throw new UsageError(`unknown argument ${arg}`)
  }
  return { project, home }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const result = await seedRegistry(args)
  process.stdout.write(formatSeedReport(result))
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`seed-registry: ${error.message}\n\n${USAGE}\n`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`seed-registry: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
