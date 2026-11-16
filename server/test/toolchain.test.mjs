import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HERDR_APP_HOME, HERDR_CORE_SHA256, HERDR_CORE_SOCKET, HERDR_CORE_VERSION, PNPM_PATH } from '../toolchain.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dockerfile = readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8')

test('the Dockerfile defaults match the pinned toolchain constants', () => {
  assert.match(dockerfile, new RegExp(`^ARG HERDR_CORE_VERSION=${HERDR_CORE_VERSION}$`, 'm'))
  assert.match(dockerfile, new RegExp(`^ARG HERDR_CORE_SHA256=${HERDR_CORE_SHA256}$`, 'm'))
  assert.match(dockerfile, new RegExp(`AUTOMAGIK_PNPM=${PNPM_PATH}`))
})

test('the image sets the Arca app home and the core socket on the data volume', () => {
  assert.match(dockerfile, new RegExp(`HERDR_APP_HOME=${HERDR_APP_HOME}`))
  assert.match(dockerfile, new RegExp(`HC_TERMINAL_SOCKET=${HERDR_CORE_SOCKET}`))
})

test('the final image carries both hc and herdr-core at literal paths', () => {
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/herdr-core \/usr\/local\/bin\/herdr-core$/m)
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/hc \/usr\/local\/bin\/hc$/m)
  assert.match(dockerfile, /\/out\/bin\/hc --version \| grep -qx "hc \$\{HERDR_CORE_VERSION\}"/)
})

test('the final image carries am from the fetched release tarball and its command shim', () => {
  assert.match(dockerfile, /^COPY --from=builder \/build\/out\/am \/opt\/automagik\/am$/m)
  assert.match(dockerfile, /^COPY --chmod=0755 server\/bin\/dsh server\/bin\/pnpm server\/bin\/am \/usr\/local\/bin\/$/m)
  assert.doesNotMatch(dockerfile, /COPY .*automagik-am-.*\.tgz/)
})

test('the reviewed skill is verified at build time and copied read-only', () => {
  assert.match(dockerfile, /RUN node \/build\/server\/verify-payload\.mjs/)
  assert.match(dockerfile, /^COPY server\/skills \/opt\/automagik\/skills$/m)
})

test('the published #1424 seed is copied into the image until the plugin carries it', () => {
  assert.match(dockerfile, /^COPY server\/vendor\/registry-seed \/opt\/automagik\/registry-seed$/m)
})

test('the first-boot hook and the in-image smoke are inside the image', () => {
  for (const file of ['first-boot.mjs', 'cli-store.mjs', 'in-image-smoke.mjs', 'toolchain.mjs']) {
    assert.match(dockerfile, new RegExp(`server/${file.replace('.', '\\.')}`), `${file} is copied into the runtime`)
  }
})
