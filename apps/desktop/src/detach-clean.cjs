// The preload closes inherited sockets before this hop starts a detached Herdr window.
const { spawn } = require('node:child_process')

const env = { ...process.env }
if (env.AUTOMAGIK_HOP_RUN_AS_NODE) {
  env.ELECTRON_RUN_AS_NODE = env.AUTOMAGIK_HOP_RUN_AS_NODE
} else {
  delete env.ELECTRON_RUN_AS_NODE
}
delete env.AUTOMAGIK_HOP_RUN_AS_NODE

try {
  const child = spawn(process.argv[2], process.argv.slice(3), {
    env, detached: true, stdio: 'ignore', windowsHide: false,
  })
  child.once('error', () => process.exit(1))
  child.once('spawn', () => {
    child.unref()
    process.exit(0)
  })
} catch {
  process.exit(1)
}
