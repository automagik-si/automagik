import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(join(ROOT, file), 'utf8')

// The image lane publishes to ghcr.io/automagik-si and the repository is automagik-si. The
// workflow passes the repository explicitly; these defaults are for a manual build, so they
// must name the canonical org too.
test('the image lane names the canonical org, automagik-si', () => {
  const lane = ['server/Dockerfile', 'server/build.mjs', 'server/fetch-plugins.mjs', 'server/assemble.mjs']
  for (const file of lane) {
    assert.doesNotMatch(read(file), /automagik-dev/, `${file} still names automagik-dev`)
  }
  const dockerfile = read('server/Dockerfile')
  assert.match(dockerfile, /ghcr\.io\/automagik-si\/automagik-server/)
  assert.match(dockerfile, /^ARG AUTOMAGIK_REPOSITORY=https:\/\/github\.com\/automagik-si\/automagik$/m)
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/automagik-si\/automagik"/)
  assert.match(read('server/build.mjs'), /'https:\/\/github\.com\/automagik-si\/automagik'/)
  assert.match(read('server/fetch-plugins.mjs'), /DEFAULT_REPOSITORY = 'https:\/\/github\.com\/automagik-si\/automagik'/)
})

