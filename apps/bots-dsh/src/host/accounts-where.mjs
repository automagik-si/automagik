// Where a launch finds claude, asked of the installed accounts CLI without running its program:
// `sh <cli>/bin/run.sh accounts-where.mjs <cli>/bin/automagik-herdr.mjs` (the CLI's own node choice).
// Importing the module does not run its main (that only runs when it is the program, which also
// repairs CLI links); its exported `launch-path` handler prints `{"program": …, "path": …}`.
import { pathToFileURL } from 'node:url'

const [entry] = process.argv.slice(2)
const { cmdLaunchPath } = await import(pathToFileURL(entry).href)
await cmdLaunchPath({}, ['claude'])
