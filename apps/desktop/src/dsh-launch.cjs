// dsh's CLI, started by the app with the app's own package manager (#1466).
//
// dsh's plugin manager installs, updates and removes the profile's plugins with pnpm. Started
// as its own `lib/bin.js`, it resolves the command `pnpm` through PATH, so a pnpm of another
// version, first on the person's PATH, ran the install (a pnpm 9 refused the profile's
// workspace root: ERR_PNPM_ADDING_TO_ROOT). This carrier imports the pinned dsh and gives its
// profile the native ProfilePnpmInvocation: this process's node (Electron's binary as Node in
// the app) runs the bundled pnpm.cjs by absolute path, so PATH order cannot choose another.
//
// It runs as Node outside the app's asar (scripts/prepare-runtime.mjs copies it there);
// startDsh names the pinned dsh entry and pnpm in the environment.
const { existsSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const ENTRY = process.env.AUTOMAGIK_DSH_ENTRY
const PNPM = process.env.AUTOMAGIK_DSH_PNPM

const missing = (what, file) => {
  process.stderr.write(`automagik: ${what} is missing at ${file}\n`)
  process.exit(1)
}
if (!ENTRY) missing("the app's dsh entry", '(not named)')
if (!existsSync(ENTRY)) missing("the app's dsh entry", ENTRY)
if (!PNPM) missing("the app's bundled pnpm", '(not named)')
if (!existsSync(PNPM)) missing("the app's bundled pnpm", PNPM)

// dsh and its plugins may read the entry script from argv (the Bot team's update check walks up
// from it for the runtime's version): name the dsh bin there, as a direct start did, not this
// launcher. runCli reads its own arguments from argv.slice(2), which does not change.
process.argv[1] = ENTRY

async function main() {
  const { runCli } = await import(pathToFileURL(ENTRY).href)
  if (typeof runCli !== 'function') throw new Error(`the installed dsh does not export runCli (${ENTRY})`)
  await runCli({
    packageManager: {
      command: process.execPath,
      args: [PNPM],
      // The command is Electron's binary in the app: it reads pnpm.cjs only as Node.
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  })
}

main().catch((error) => {
  process.stderr.write(`automagik: dsh did not start: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
